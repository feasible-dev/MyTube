import { requestDiscoveryPlan } from './discovery.mjs';
import { LiveSearchError } from './youtube-live.mjs';
import { validatePreferences } from './preferences.mjs';
import { matchesQuickSubject } from './quick-relevance.mjs';

export function validateWebVideos(value) {
  if (!Array.isArray(value?.videos) || value.videos.length > 60 || !Number.isInteger(value.searches) || value.searches < 1 || value.searches > 36) throw new LiveSearchError('INVALID_RESPONSE');
  const ids = new Set();
  for (const v of value.videos) {
    if (!v || !/^[A-Za-z0-9_-]{11}$/.test(v.video_id) || ids.has(v.video_id) || v.source !== 'youtube_web'
      || v.source_url !== `https://www.youtube.com/watch?v=${v.video_id}`
      || !['direct', 'adjacent', 'wildcard'].includes(v.discovery_stream)
      || !['title', 'channel'].every(k => typeof v[k] === 'string' && v[k].trim() && v[k].length <= 500)
      || typeof v.discovery_why !== 'string' || v.discovery_why.length > 200
      || v.duration_seconds !== null || v.published_at !== null || v.views !== null) throw new LiveSearchError('INVALID_RESPONSE');
    ids.add(v.video_id);
  }
  return value;
}
export async function discoverWebVideos({ intention, signal, preferences, fetchImpl = fetch, watch, onStage = () => {}, onProgress = () => {}, cached = [] }) {
  const start = performance.now(), choices = validatePreferences(preferences);
  const matches = cached.filter(v => matchesQuickSubject(v, intention));
  let latest, firstResults;
  const initial = matches.length ? { query: intention, videos: matches, preferences: choices, provisional: true,
    provisional_source: 'cache', fetched_at: new Date().toISOString(), complete: false, requests: 0, search_results: matches.length } : null;
  if (signal?.aborted) throw new LiveSearchError('CANCELLED');
  if (initial) { latest = initial; firstResults = 0; onProgress(initial); }
  onStage('web-search');
  const asResult = (result, complete, adjustments = []) => {
    const elapsed = Math.round(performance.now() - start);
    if (result.videos.length && firstResults === undefined) firstResults = elapsed;
    return { query: intention, videos: result.videos.map((v, i) => ({ ...v, provider_rank: i + 1, discovery_query: v.discovery_why })),
      streams: Object.fromEntries(['direct', 'adjacent', 'wildcard'].map(stream => [stream, {
        query: '', searches: [], why: 'Videos located through ChatGPT web search and checked with YouTube.',
        videos: result.videos.filter(v => v.discovery_stream === stream),
      }])), preferences: choices, fetched_at: new Date().toISOString(), complete, provisional: !complete, provider: 'chatgpt_web',
      requests: 0, web_searches: result.searches, search_results: result.videos.length, adjustments,
      timing_ms: { planning: elapsed, first_results: firstResults ?? elapsed, total: elapsed } };
  };
  const partial = result => { latest = asResult(result, false); onProgress(latest); };
  const waiting = busy => onStage(busy ? 'waiting-connector' : 'web-search');
  try {
    let result; const adjustments = [];
    try { result = await requestDiscoveryPlan(intention, signal, fetchImpl, watch, choices, undefined, validateWebVideos, partial, waiting); }
    catch (error) {
      if (signal?.aborted || !['WEB_SEARCH_NO_SOURCED_VIDEOS', 'INVALID_SEARCH_PLAN'].includes(error?.code)) throw error;
      onStage('web-search');
      result = await requestDiscoveryPlan(intention, signal, fetchImpl, watch, choices, 'NO_RESULTS', validateWebVideos, partial, waiting);
      adjustments.push({ reason: error.code, previous_queries: [], queries: [] });
    }
    const output = asResult(result, true, adjustments);
    onProgress(output); return output;
  } catch (error) {
    if (signal?.aborted || error?.code === 'CANCELLED' || !latest?.videos.length) throw error;
    return { ...latest, complete: true, warning: error?.code ?? 'REQUEST_FAILED' };
  }
}
