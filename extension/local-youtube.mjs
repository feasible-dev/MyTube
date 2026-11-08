import { combineAngles, diversifyAngles } from './or-search.mjs';
import { LiveSearchError } from './youtube-live.mjs';
import { validatePreferences } from './preferences.mjs';
import { requestDiscoveryPlan } from './discovery.mjs';
import { quickApiQuery, matchesQuickSubject, quickSubjectTerms, explicitFilmTitle } from './quick-relevance.mjs';
import { matchesDirectSubject } from './direct-relevance.mjs';
import { selectSearchColumns } from '../poc/model.mjs';

const LOCAL_YOUTUBE_ERRORS = new Set(['WINDOWS_KEY_UNAVAILABLE', 'YOUTUBE_KEY_MISSING', 'YOUTUBE_KEY_INVALID', 'INVALID_QUERY', 'INVALID_PREFERENCES', 'CONNECTOR_BUSY',
  'CANCELLED', 'TIMEOUT', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'ACCESS_OR_QUOTA_DENIED', 'PROVIDER_UNAVAILABLE', 'REQUEST_FAILED', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE']);

export async function localYouTubeRequest(operation, body, signal, fetchImpl = globalThis.fetch) {
  if (!['status', 'setup', 'search', 'durations'].includes(operation)) throw new LiveSearchError('INVALID_QUERY');
  const timeout = AbortSignal.timeout(operation === 'status' ? 2500 : 19000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response, reader;
  try {
    response = await fetchImpl(`http://127.0.0.1:43817/youtube/${operation}`, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', 'X-MyTube-Request': crypto.randomUUID() }, body: JSON.stringify(body), signal: combined });
    if (response.status === 404) throw new LiveSearchError('CONNECTOR_UPDATE_REQUIRED');
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new LiveSearchError('INVALID_RESPONSE');
    reader = response.body.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > 1048576) throw new LiveSearchError('RESPONSE_TOO_LARGE'); text += decoder.decode(value, { stream: true }); }
    const value = JSON.parse(text + decoder.decode());
    if (!response.ok) throw new LiveSearchError(LOCAL_YOUTUBE_ERRORS.has(value?.error) ? value.error : 'REQUEST_FAILED');
    return value;
  } catch (error) {
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    if (timeout.aborted) throw new LiveSearchError('TIMEOUT');
    throw error instanceof LiveSearchError ? error : new LiveSearchError('CONNECTOR_UNAVAILABLE');
  } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } else await response?.body?.cancel().catch(() => {}); }
}

// Three initial pages, then at most two single-angle top-ups for sparse columns.
export async function discoverLocalYouTube({ intention, signal, preferences, onStage = () => {}, onProgress = () => {},
  search = (query, choices, requestSignal) => localYouTubeRequest('search', { query, preferences: choices }, requestSignal),
  plan = requestSignal => requestDiscoveryPlan(intention, requestSignal, globalThis.fetch, undefined, preferences), planTimeoutMs = 45000, wildcards, preparedPlan }) {
  const choices = validatePreferences(preferences), start = performance.now();
  const filmTitle = explicitFilmTitle(intention);
  const controller = new AbortController();
  const planSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(planTimeoutMs), ...(signal ? [signal] : [])]);
  const planning = Promise.resolve().then(() => preparedPlan ?? plan(planSignal)).then(value => ({ value }), error => ({ error }));
  let videos = [], requests = 0, searchResults = 0, searches = 0, firstResults = null, warning;
  const streams = Object.fromEntries(['direct', 'adjacent', 'wildcard'].map(s => [s, { query: '', why: '', searches: [], videos: [], status: 'pending' }]));
  const snapshot = complete => ({ query: intention, preferences: choices, videos, streams, provider: 'youtube_api',
    fetched_at: new Date().toISOString(), complete, provisional: !complete, requests, search_results: searchResults,
    youtube_searches: searches, ...(warning ? { warning } : {}), timing_ms: { first_results: firstResults, planning: planningMs, total: Math.round(performance.now() - start) } });
  let directSubjects, planningMs, webPending = Boolean(wildcards);
  const collect = async (query, stream, why, angles = [query]) => {
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    if (searches >= 5) return;
    onStage('youtube'); searches++; streams[stream].status = 'searching';
    streams[stream].query = query; streams[stream].why = why;
    const attempt = { query, why, status: 'searching' }; streams[stream].searches.push(attempt);
    let result;
    try { result = await search(query, choices, signal); }
    catch (error) { attempt.status = 'failed'; streams[stream].status = 'failed'; streams[stream].error = error?.code ?? 'REQUEST_FAILED'; onProgress(snapshot(false)); throw error; }
    if (!Array.isArray(result?.videos) || result.videos.length > 50 || result.videos.some(v => v.source !== 'youtube_live'
      || !/^[A-Za-z0-9_-]{11}$/.test(v.video_id) || typeof v.title !== 'string' || typeof v.channel !== 'string'
      || !Number.isFinite(v.duration_seconds) || v.duration_seconds <= 0)) throw new LiveSearchError('INVALID_RESPONSE');
    requests += result.requests; searchResults += result.search_results;
    // Pools may overlap. Only the cards actually selected by the UI reserve an
    // ID across columns; hidden candidates in DIRECT must not starve RELATED.
    const seen = new Set(streams[stream].videos.map(v => v.video_id));
    const anchored = stream === 'direct' && !directSubjects && quickSubjectTerms(query).length
      ? result.videos.filter(v => filmTitle ? matchesDirectSubject(v, query, [filmTitle]) : matchesQuickSubject(v, query)) : [];
    // Multiword topics deserve the same focus as single-word subjects.
    // If no spelling matches (e.g. translated results), trust provider ranking
    // rather than turning a valid response into an empty page.
    const candidates = stream === 'direct' && !directSubjects && filmTitle ? anchored : anchored.length ? anchored : result.videos;
    for (const v of diversifyAngles(candidates, angles)) {
      // YouTube ranks this newly executed query. A French-only lexical test
      // cannot judge its English results. Refine with bilingual plan aliases
      // when available; the stricter cached-result guard remains unchanged.
      if (stream === 'direct' && directSubjects && !matchesDirectSubject(v, query, directSubjects)) {
        attempt.off_topic_filtered = (attempt.off_topic_filtered ?? 0) + 1; continue;
      }
      if (seen.has(v.video_id)) continue; seen.add(v.video_id);
      const row = { ...v, discovery_stream: stream, discovery_query: v.discovery_query ?? query, discovery_why: why };
      videos.push(row); streams[stream].videos.push(row);
    }
    attempt.status = 'complete'; attempt.candidates = result.videos.length;
    delete streams[stream].error;
    streams[stream].status = stream === 'wildcard' && webPending ? 'searching' : stream === 'direct' && !directSubjects && !streams.direct.videos.length ? 'pending' : 'complete';
    if (videos.length) firstResults ??= Math.round(performance.now() - start);
    onProgress(snapshot(false));
  };
  try {
    if (preparedPlan) directSubjects = preparedPlan.direct_subjects;
    const directAngles = preparedPlan ? combineAngles(preparedPlan.direct_subjects?.length ? preparedPlan.direct_subjects.map(name => `"${name.replaceAll('"', '')}"`) : preparedPlan.queries.filter(q => q.stream === 'direct').map(q => q.query)) : combineAngles([quickApiQuery(intention) ?? '']);
    const quick = directAngles.query;
    if (quick) await collect(quick, 'direct', 'YouTube results for your request.', directAngles.angles);
    const prepared = await planning;
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    if (prepared.error) throw prepared.error;
    directSubjects = prepared.value.direct_subjects;
    planningMs = Math.round(performance.now() - start);
    streams.direct.subjects = directSubjects;
    let webRows = [], webDetails = [];
    const acceptWildcards = batch => {
      webRows = batch.videos;
      webDetails = batch.search_details ?? webDetails;
      // Web snapshots must never replace API results in the same column.
      const apiRows = streams.wildcard.videos.filter(v => v.source === 'youtube_live');
      const ids = new Set(apiRows.map(v => v.video_id));
      streams.wildcard.videos = [...apiRows, ...webRows.filter(v => !ids.has(v.video_id))];
      videos = [...videos.filter(v => v.discovery_stream !== 'wildcard'), ...streams.wildcard.videos];
      streams.wildcard.searches = [...streams.wildcard.searches.filter(s => !s.platforms), ...webDetails];
      onProgress(snapshot(false));
    };
    const apiColumns = async () => {
      const queue = (quick ? ['adjacent', 'wildcard'] : ['direct', 'adjacent', 'wildcard']).map(stream => {
        const directions = prepared.value.queries.filter(q => q.stream === stream);
        return { ...combineAngles(directions.map(q => q.query)), stream, why: directions[0]?.why ?? '' };
      }).filter(q => q.query);
      for (const q of queue) {
        if (signal?.aborted) throw new LiveSearchError('CANCELLED');
        try { await collect(q.query, q.stream, q.why, q.angles); }
        catch (error) {
          if (signal?.aborted) throw error;
          warning = error?.code ?? 'REQUEST_FAILED';
          if (['QUOTA_EXCEEDED', 'YOUTUBE_KEY_INVALID', 'ACCESS_OR_QUOTA_DENIED'].includes(error?.code)) break;
        }
      }
    };
    if (wildcards) streams.wildcard.status = 'searching';
    const jobs = [apiColumns()];
    if (wildcards) jobs.push(Promise.resolve().then(() => wildcards(signal, acceptWildcards))
      .then(acceptWildcards, error => {
        streams.wildcard.web_error = error?.code ?? 'REQUEST_FAILED';
        // API discoveries remain usable even when independent web search fails.
      }).finally(() => { webPending = false; }));
    const settled = await Promise.allSettled(jobs);
    for (const result of settled) if (result.status === 'rejected') warning = result.reason?.code ?? 'REQUEST_FAILED';
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    // Wait for external discoveries before spending quota on their column.
    // Count selectable cards, not raw pools: duplicates and creator limits can
    // leave a column empty even when a provider returned many candidates.
    const toppedUp = new Set();
    const fatal = new Set(['QUOTA_EXCEEDED', 'YOUTUBE_KEY_MISSING', 'YOUTUBE_KEY_INVALID', 'ACCESS_OR_QUOTA_DENIED', 'RATE_LIMITED']);
    while (searches < 5 && toppedUp.size < 2 && !fatal.has(warning)) {
      const selected = selectSearchColumns(videos, true);
      const sparse = ['direct', 'adjacent', 'wildcard'].map(stream => {
        const previous = streams[stream].searches.filter(s => !s.platforms);
        const used = new Set(previous.flatMap(s => s.query.split(' | ').map(q => q.trim().toLowerCase())));
        const directions = prepared.value.queries.filter(q => q.stream === stream && !q.query.includes('|'));
        // Prefer an unused planned angle, then isolate a branch drowned out by OR.
        const next = directions.find(q => !used.has(q.query.trim().toLowerCase()))
          ?? directions.find(q => !previous.some(s => s.query === q.query));
        return { stream, count: selected[stream === 'adjacent' ? 'related' : stream].length, next };
      }).filter(q => q.count < 6 && q.next && !toppedUp.has(q.stream)).sort((a, b) => a.count - b.count);
      if (!sparse.length) break;
      const { stream, next, count } = sparse[0];
      toppedUp.add(stream);
      try { await collect(next.query, stream, `Additional angle: only ${count} selectable videos. ${next.why}`); }
      catch (error) {
        if (signal?.aborted) throw error;
        warning = error?.code ?? 'REQUEST_FAILED';
      }
    }
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    for (const direction of Object.values(streams)) {
      direction.status = direction.videos.length ? 'complete' : direction.error || direction.web_error ? 'failed' : 'complete';
    }
    return snapshot(true);
  } catch (error) {
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    if (!videos.length) throw error;
    warning = error?.code ?? 'REQUEST_FAILED'; return snapshot(true);
  } finally { controller.abort(); }
}
