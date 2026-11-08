import { randomInt, randomUUID } from 'node:crypto';

export class SafeError extends Error {}
const fail = code => { throw new SafeError(code); };
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);

export function validateApiKey(value) {
  if (typeof value !== 'string' || !value.trim()) fail('API_KEY_EMPTY');
  const key = value.trim();
  if (key.length < 20 || key.length > 200) fail('API_KEY_LENGTH_INVALID');
  if (!/^[A-Za-z0-9_-]+$/.test(key)) fail('API_KEY_CHARACTERS_INVALID');
  return key;
}

export function validatePlan(plan) {
  if (plan?.version !== 1 || plan.relevance_language !== 'en' || plan.results_per_query !== 25
    || !Array.isArray(plan.intents) || plan.intents.length !== 3) fail('INVALID_PLAN');
  const ids = new Set();
  for (const intent of plan.intents) {
    if (!/^[a-z]+$/.test(intent.id) || ids.has(intent.id)
      || typeof intent.description !== 'string' || intent.description.length > 500
      || !Number.isFinite(intent.min_minutes) || !Number.isFinite(intent.max_minutes)
      || intent.min_minutes < 15 || intent.max_minutes > 120 || intent.min_minutes > intent.max_minutes
      || !Array.isArray(intent.queries) || intent.queries.length !== 4
      || intent.queries.some(q => typeof q !== 'string' || q.length < 5 || q.length > 150)
      || new Set(intent.queries).size !== 4
      || !Array.isArray(intent.terms) || intent.terms.length > 20
      || intent.terms.some(t => !/^[a-z]+$/.test(t))) fail('INVALID_PLAN');
    ids.add(intent.id);
  }
  return plan;
}

// Deliberately supports only fixed day/hour/minute/second durations, not calendar units.
export function durationSeconds(value) {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m || !m.slice(1).some(v => v !== undefined) || value.endsWith('T')) return null;
  const seconds = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600
    + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= Number.MAX_SAFE_INTEGER ? seconds : null;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, max);
}

export function normalizeVideo(item) {
  if (!validId(item?.id) || !item.snippet || !item.contentDetails) fail('INVALID_VIDEO_METADATA');
  return {
    video_id: item.id,
    title: cleanText(item.snippet.title, 500),
    channel: cleanText(item.snippet.channelTitle, 500),
    description: cleanText(item.snippet.description, 6000),
    published_at: cleanText(item.snippet.publishedAt, 40),
    duration_seconds: durationSeconds(item.contentDetails.duration),
    live_status: ['none', 'live', 'upcoming'].includes(item.snippet.liveBroadcastContent)
      ? item.snippet.liveBroadcastContent : 'unknown',
    url: `https://www.youtube.com/watch?v=${item.id}`,
    short: null,
  };
}

// Spreadsheet formula protection as well as RFC-style CSV quoting.
export function csvCell(value) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function toCsv(columns, rows) {
  return [columns.map(csvCell).join(','), ...rows.map(row => columns.map(k => csvCell(row[k])).join(','))].join('\r\n') + '\r\n';
}

export function rankCandidates(intent, candidates) {
  const eligible = candidates.filter(v => Number.isFinite(v.duration_seconds)
    && v.duration_seconds >= intent.min_minutes * 60 && v.duration_seconds <= intent.max_minutes * 60
    && v.live_status === 'none');
  const baselineCompare = (a, b) => a.best_search_rank - b.best_search_rank
    || a.first_query_index - b.first_query_index || a.video_id.localeCompare(b.video_id, 'en');
  const scored = eligible.map(v => {
    const title = new Set(v.title.toLowerCase().match(/[a-z]+/g) ?? []);
    const description = new Set(v.description.toLowerCase().match(/[a-z]+/g) ?? []);
    const matched = intent.terms.filter(t => title.has(t) || description.has(t));
    return { ...v, keyword_score: intent.terms.reduce((sum, t) => sum + (title.has(t) ? 2 : description.has(t) ? 1 : 0), 0), matched_terms: matched };
  });
  return {
    eligible_count: eligible.length,
    search_baseline: [...scored].sort(baselineCompare).slice(0, 10),
    keyword_baseline: [...scored].sort((a, b) => b.keyword_score - a.keyword_score || baselineCompare(a, b)).slice(0, 10),
  };
}

export function makeRatingPacket(intent, ranked) {
  const unique = new Map();
  for (const method of ['search_baseline', 'keyword_baseline']) {
    ranked[method].forEach((video, index) => {
      if (!unique.has(video.video_id)) unique.set(video.video_id, { video, memberships: [] });
      unique.get(video.video_id).memberships.push({ method, rank: index + 1 });
    });
  }
  const entries = [...unique.values()];
  for (let i = entries.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const tasks = [], mapping = [];
  for (const { video, memberships } of entries) {
    const item_id = randomUUID();
    tasks.push({ item_id, intent: intent.id, title: video.title, channel: video.channel,
      duration_minutes: Math.round(video.duration_seconds / 6) / 10, url: video.url,
      relevant: '', want_to_watch: '', already_known: '', perceived_quality: '', short: '', notes: '' });
    mapping.push({ item_id, intent: intent.id, video_id: video.video_id, memberships });
  }
  return { tasks, mapping };
}

export function createClient(apiKey, ledger, fetchImpl = fetch, timeoutMs = 20000) {
  apiKey = validateApiKey(apiKey);
  return async (endpoint, params) => {
    if (!['search', 'videos'].includes(endpoint)) fail('INVALID_ENDPOINT');
    if (Object.hasOwn(params, 'key') || Object.hasOwn(params, 'pageToken')) fail('INVALID_REQUEST_PARAMETERS');
    const maxCalls = endpoint === 'search' ? 12 : 6;
    if (ledger.filter(entry => entry.endpoint === endpoint).length >= maxCalls) fail('REQUEST_BUDGET_EXCEEDED');
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    url.search = new URLSearchParams(params).toString();
    const entry = { endpoint, attempted: true, http_status: null, response_bytes: 0 };
    ledger.push(entry);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader, response;
    try {
      response = await fetchImpl(url, { headers: { 'x-goog-api-key': apiKey, Accept: 'application/json' },
        redirect: 'error', signal: controller.signal });
      entry.http_status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        // Never retain provider error messages, which can include credentials or IPs.
        fail(`HTTP_${response.status}`);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail('INVALID_CONTENT_TYPE');
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) fail('BODY_TOO_LARGE');
      if (!response.body) fail('MISSING_BODY');
      reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        entry.response_bytes += value.length;
        if (entry.response_bytes > 2 * 1024 * 1024) fail('BODY_TOO_LARGE');
        chunks.push(value);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.includes(apiKey)) fail('CREDENTIAL_ECHO_REJECTED');
      let data;
      try { data = JSON.parse(body); } catch { fail('INVALID_JSON'); }
      if (!data || !Array.isArray(data.items) || data.items.length > (endpoint === 'search' ? 25 : 50)) fail('INVALID_RESPONSE');
      return data.items;
    } catch (error) {
      if (error instanceof SafeError) throw error;
      fail(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {});
    }
  };
}

export async function collect(plan, request) {
  validatePlan(plan);
  const hits = new Map();
  const queryResults = [];
  for (const intent of plan.intents) {
    for (const [queryIndex, query] of intent.queries.entries()) {
      const items = await request('search', { part: 'snippet', type: 'video', q: query,
        maxResults: '25', order: 'relevance', relevanceLanguage: plan.relevance_language, safeSearch: 'moderate' });
      queryResults.push({ intent: intent.id, query, returned: items.length });
      for (const [index, item] of items.entries()) {
        const id = item?.id?.videoId;
        if (!validId(id)) fail('INVALID_SEARCH_VIDEO_ID');
        if (!hits.has(id)) hits.set(id, []);
        hits.get(id).push({ intent: intent.id, query, query_index: queryIndex, search_rank: index + 1 });
      }
    }
  }
  const ids = [...hits.keys()], videos = new Map();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50), expected = new Set(batch);
    const items = await request('videos', { part: 'snippet,contentDetails', id: batch.join(',') });
    for (const item of items) {
      if (!expected.has(item?.id) || videos.has(item.id)) fail('UNEXPECTED_VIDEO_ID');
      videos.set(item.id, normalizeVideo(item));
    }
  }
  const candidates = [];
  for (const intent of plan.intents) {
    for (const [id, origins] of hits) {
      const matching = origins.filter(hit => hit.intent === intent.id);
      if (!matching.length || !videos.has(id)) continue;
      candidates.push({ intent: intent.id, ...videos.get(id),
        originating_queries: [...new Set(matching.map(hit => hit.query))].join(' | '),
        origins: matching, best_search_rank: Math.min(...matching.map(hit => hit.search_rank)),
        first_query_index: Math.min(...matching.map(hit => hit.query_index)) });
    }
  }
  return { query_results: queryResults, unique_search_ids: ids.length,
    missing_metadata_ids: ids.filter(id => !videos.has(id)), candidates };
}
