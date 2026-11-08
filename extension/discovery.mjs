import { PLAN_ERROR_CODES, PLAN_RECOVERY_REASONS } from './plan-errors.mjs';
import { fetchYouTubeResults, LiveSearchError, createChannelAvatarLoader } from './youtube-live.mjs';
import { containsSubject, validDirectSubjects, matchesDirectSubject, normalizeSubject, validPlanText, PLAN_QUERY_PATTERN, PLAN_EXPLANATION_PATTERN } from './direct-relevance.mjs';

import { validatePreferences } from './preferences.mjs';

const CONNECTOR_URL = 'http://127.0.0.1:43817/plan';
const DISCOVERY_STREAMS = ['direct', 'adjacent', 'wildcard'];
export function validateDiscoveryPlan(value) {
  if (!value || !Object.keys(value).every(k => ['queries', 'direct_subjects'].includes(k)) || !Array.isArray(value.queries) || ![3, 12].includes(value.queries.length)) throw new LiveSearchError('INVALID_SEARCH_PLAN');
  if (Object.hasOwn(value, 'direct_subjects') && !validDirectSubjects(value.direct_subjects)) throw new LiveSearchError('INVALID_PLAN_SUBJECTS');
  const seen = new Set();
  const perStream = value.queries.length / 3;
  for (let i = 0; i < value.queries.length; i++) {
    const q = value.queries[i];
    if (!q || Object.keys(q).length !== 3 || q.stream !== DISCOVERY_STREAMS[Math.floor(i / perStream)]
      || !validPlanText(q.query, PLAN_QUERY_PATTERN)
      || !validPlanText(q.why, PLAN_EXPLANATION_PATTERN)) throw new LiveSearchError('INVALID_SEARCH_PLAN');
    const canonical = q.query.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (seen.has(canonical)) throw new LiveSearchError('REPEATED_SEARCH_QUERIES');
    seen.add(canonical);
    if (q.stream === 'direct' && value.direct_subjects && !value.direct_subjects.some(s => containsSubject(q.query, s))) throw new LiveSearchError('OFF_TOPIC_SEARCH_PLAN');
  }
  return value;
}
function waitForConnector(signal) {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, 1000);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new LiveSearchError('CANCELLED')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function requestDiscoveryPlan(intention, signal, fetchImpl = globalThis.fetch, watch, preferences, recovery, webValidator, onPartial, onWaiting = () => {}, connectionOnly = false, wildcardOnly = false, interpretationOnly = false) {
  if (typeof intention !== 'string' || !intention.trim() || intention.length > 6000
    || new TextEncoder().encode(intention).length > 8000) throw new LiveSearchError('INVALID_INTENTION');
  if (signal?.aborted) throw new LiveSearchError('CANCELLED');
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, interpretationOnly ? 45000 : 360000);
  let reader, monitor, monitorError;
  const requestId = watch || connectionOnly ? crypto.randomUUID() : null;
  try {
    const send = () => fetchImpl(interpretationOnly ? 'http://127.0.0.1:43817/interpret' : connectionOnly ? 'http://127.0.0.1:43817/connect' : wildcardOnly ? 'http://127.0.0.1:43817/wildcard-discover' : webValidator ? 'http://127.0.0.1:43817/web-discover' : CONNECTOR_URL, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', ...(webValidator ? { Accept: 'application/x-ndjson' } : {}), ...(requestId ? { 'X-MyTube-Request': requestId } : {}) },
      body: JSON.stringify(connectionOnly ? {} : { intention: intention.trim(), ...(preferences ? { preferences: validatePreferences(preferences) } : {}), ...(recovery ? { recovery } : {}) }), signal: controller.signal });
    if (watch) monitor = watch({ requestId, signal: controller.signal, fetchImpl }).catch(error => { monitorError = error; controller.abort(); });
    let response = await send(), waits = 0;
    while (response.status === 409 && waits++ < 30) {
      await response.body?.cancel().catch(() => {});
      onWaiting(true);
      await waitForConnector(controller.signal);
      response = await send();
    }
    onWaiting(false);
    if ((connectionOnly || interpretationOnly) && response.status === 404) { await response.body?.cancel().catch(() => {}); throw new LiveSearchError('CONNECTOR_UPDATE_REQUIRED'); }
    if (response.status === 403) { await response.body?.cancel().catch(() => {}); throw new LiveSearchError('CONNECTOR_ACCESS_DENIED'); }
    const streaming = webValidator && /^application\/x-ndjson(?:;|$)/i.test(response.headers.get('content-type') ?? '');
    if ((!streaming && !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) || !response.body) throw new LiveSearchError('INVALID_SEARCH_PLAN');
    reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
    let body = '', bytes = 0, finalValue;
    const consumeLines = () => {
      let end;
      while ((end = body.indexOf('\n')) >= 0) {
        const line = body.slice(0, end); body = body.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === 'error') throw new LiveSearchError(PLAN_ERROR_CODES.includes(message.error) ? message.error : 'CHATGPT_FAILED');
        if (finalValue || !['progress', 'result'].includes(message.type)) throw new LiveSearchError('INVALID_RESPONSE');
        const value = webValidator(message);
        if (message.type === 'progress') onPartial?.(value);
        else finalValue = value;
      }
    };
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > (streaming ? 2097152 : webValidator ? 131072 : 32768)) throw new LiveSearchError('INVALID_SEARCH_PLAN');
      body += decoder.decode(value, { stream: true });
      if (streaming) { if (body.length > 131072) throw new LiveSearchError('INVALID_RESPONSE'); consumeLines(); }
    }
    body += decoder.decode();
    if (streaming) {
      consumeLines();
      if (body.trim() || !finalValue) throw new LiveSearchError('CHATGPT_RESPONSE_INCOMPLETE');
      return finalValue;
    }
    const value = JSON.parse(body);
    if (!response.ok) throw new LiveSearchError(PLAN_ERROR_CODES.includes(value?.error) ? value.error : 'CHATGPT_FAILED');
    return webValidator ? webValidator(value) : validateDiscoveryPlan(value);
  } catch (error) {
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    if (monitorError) throw monitorError instanceof LiveSearchError ? monitorError : new LiveSearchError('SIGN_IN_WINDOW_FAILED');
    if (controller.signal.aborted) throw new LiveSearchError('CHATGPT_TIMEOUT');
    if (error instanceof LiveSearchError) throw error;
    throw new LiveSearchError('CONNECTOR_UNAVAILABLE');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); await monitor; if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
}
export function prepareChatGPT(signal, fetchImpl = globalThis.fetch, watch, onWaiting) {
  const validate = value => {
    if (!value || value.connected !== true || Object.keys(value).length !== 1) throw new LiveSearchError('CONNECTOR_PROTOCOL_ERROR');
    return value;
  };
  return requestDiscoveryPlan('connect', signal, fetchImpl, watch, undefined, undefined, validate, undefined, onWaiting, true);
}
// Allocate overlapping pools one item per direction at a time, giving scarce
// pools first choice. DIRECT must not reserve every shared result in advance.
export function allocateDiscoveryPools(pools) {
  const order = [...DISCOVERY_STREAMS].sort((a, b) => pools[a].length - pools[b].length);
  const rows = Object.fromEntries(DISCOVERY_STREAMS.map(s => [s, []]));
  const cursors = Object.fromEntries(DISCOVERY_STREAMS.map(s => [s, 0]));
  const used = new Set(); let added;
  do {
    added = false;
    for (const stream of order) {
      let row;
      while (cursors[stream] < pools[stream].length) {
        const candidate = pools[stream][cursors[stream]++];
        if (!used.has(candidate.video_id)) { row = candidate; break; }
      }
      if (row) { used.add(row.video_id); rows[stream].push(row); added = true; }
    }
  } while (added);
  return rows;
}
export async function discoverVideos({ intention, getToken, signal, fetchImpl = globalThis.fetch, onStage = () => {}, onProgress = () => {}, watch, preferences }) {
  const chosen = validatePreferences(preferences);
  const started = performance.now();
  onStage('planning');
  let plan, inferenceRequests = 0, planningMs = 0;
  const adjustments = [];
  const prepare = async (recovery, planSignal = signal) => {
    inferenceRequests++;
    const before = performance.now();
    try { return await requestDiscoveryPlan(intention, planSignal, fetchImpl, watch, preferences, recovery); }
    finally { planningMs += Math.round(performance.now() - before); }
  };
  try { plan = await prepare(); }
  catch (error) {
    if (signal?.aborted || !PLAN_RECOVERY_REASONS.includes(error?.code)) throw error;
    onStage('refining');
    plan = await prepare(error.code);
    adjustments.push({ reason: error.code, previous_queries: [], queries: plan.queries.map(q => ({ stream: q.stream, query: q.query })) });
  }
  if (signal?.aborted) throw new LiveSearchError('CANCELLED');
  onStage('youtube');
  const token = await getToken();
  const pools = {}, queues = {}, attempted = {}, poolIds = {};
  for (const stream of DISCOVERY_STREAMS) { pools[stream] = []; poolIds[stream] = new Set(); attempted[stream] = []; queues[stream] = plan.queries.filter(q => q.stream === stream); }
  let requests = 0, avatarRequests = 0, searchResults = 0, firstResultsMs = null, firstError;
  const controller = new AbortController();
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const loadAvatars = createChannelAvatarLoader({ token, signal: controller.signal, fetchImpl,
    onRequest: () => { requests++; avatarRequests++; } });
  const deadline = setTimeout(() => { firstError ??= new LiveSearchError('TIMEOUT'); controller.abort(); }, 120000);
  const snapshot = (complete = false) => {
    const allocated = allocateDiscoveryPools(pools), streams = {};
    for (const stream of DISCOVERY_STREAMS) {
      const initial = plan.queries.find(q => q.stream === stream);
      streams[stream] = { query: initial.query, why: initial.why, searches: attempted[stream].map(q => ({ ...q })), videos: allocated[stream], ...(stream === 'direct' ? { subjects: plan.direct_subjects ?? [] } : {}) };
    }
    const videos = DISCOVERY_STREAMS.flatMap(s => allocated[s]);
    if (firstResultsMs === null && videos.length) firstResultsMs = Math.round(performance.now() - started);
    return { query: intention, preferences: chosen, fetched_at: new Date().toISOString(), videos, streams, complete,
      search_results: searchResults, requests, avatar_requests: avatarRequests, inference_requests: inferenceRequests, adjustments,
      timing_ms: { planning: planningMs, first_results: firstResultsMs, total: Math.round(performance.now() - started) } };
  };
  const search = async stream => {
    if (controller.signal.aborted) throw new LiveSearchError('CANCELLED');
    const q = queues[stream].shift();
    const record = { query: q.query, why: q.why, status: 'searching', off_topic_filtered: 0 }; attempted[stream].push(record);
    try {
      const result = await fetchYouTubeResults({ query: q.query, token, signal: controller.signal, fetchImpl, preferences: chosen, relevanceLanguage: chosen.languages[plan.queries.indexOf(q) % chosen.languages.length] });
      requests += result.requests; searchResults += result.search_results; record.status = 'complete';
      const added = [];
      for (const video of result.videos) {
        if (stream === 'direct' && !matchesDirectSubject(video, q.query, plan.direct_subjects)) { record.off_topic_filtered++; continue; }
        if (poolIds[stream].has(video.video_id)) continue;
        poolIds[stream].add(video.video_id);
        const row = { ...video, discovery_stream: stream, discovery_query: q.query, discovery_why: q.why };
        pools[stream].push(row); added.push(row);
      }
      if (!controller.signal.aborted) onProgress(snapshot());
      // Show videos first; the optional channel pictures arrive afterwards.
      if (await loadAvatars(added) && !controller.signal.aborted) onProgress(snapshot());
    } catch (error) { record.status = 'failed'; firstError ??= error; controller.abort(); throw error; }
  };
  try {
    // Execute every planned angle, even if the first one yields fifty videos.
    // Counts alone cannot establish diversity. Each round has at most three
    // concurrent requests, and completed batches remain visible immediately.
    for (let round = 0; round < 8; round++) {
      const needed = DISCOVERY_STREAMS.filter(s => queues[s].length);
      if (!needed.length) {
        if (inferenceRequests >= 2 || Object.values(pools).some(rows => rows.length)) break;
        onStage('refining');
        const previous = plan.queries.map(q => ({ stream: q.stream, query: q.query }));
        plan = await prepare('NO_RESULTS', controller.signal);
        if (controller.signal.aborted) throw firstError ?? new LiveSearchError('CANCELLED');
        adjustments.push({ reason: 'NO_RESULTS', previous_queries: previous, queries: plan.queries.map(q => ({ stream: q.stream, query: q.query })) });
        for (const stream of DISCOVERY_STREAMS) queues[stream] = plan.queries.filter(q => q.stream === stream
          && !Object.values(attempted).flat().some(old => normalizeSubject(old.query) === normalizeSubject(q.query)));
        needed.push(...DISCOVERY_STREAMS.filter(s => queues[s].length));
        onProgress(snapshot());
        if (!needed.length) break;
      }
      if (round) onStage('exploring');
      const results = await Promise.allSettled(needed.map(search));
      if (results.some(r => r.status === 'rejected') || controller.signal.aborted) throw firstError ?? new LiveSearchError('CANCELLED');
    }
    const result = snapshot(true); onProgress(result); return result;
  } finally {
    clearTimeout(deadline); signal?.removeEventListener('abort', cancel); controller.abort();
  }
}
