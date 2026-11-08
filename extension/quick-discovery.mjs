import { discoverVideos } from './discovery.mjs';
import { fetchYouTubeResults, LiveSearchError } from './youtube-live.mjs';
import { validatePreferences, languageMatches } from './preferences.mjs';
import { conciseQuickQuery, quickSubjectTerms, matchesQuickSubject } from './quick-relevance.mjs';

export function quickSearchQuery(intention) {
  return conciseQuickQuery(intention);
}
export async function discoverQuickly({ intention, signal, preferences, getToken, getQuickToken = getToken,
  fetchImpl = globalThis.fetch, watch, onStage = () => {}, onProgress = () => {}, cached = [], quickTimeoutMs = 8000 }) {
  const start = performance.now(); let latest = null, enhanced = false, firstMs = null;
  const planningController = new AbortController();
  let stopForGoogle;
  const googleBlocked = new Promise((_, reject) => { stopForGoogle = reject; });
  preferences = validatePreferences(preferences);
  const query = quickSearchQuery(intention);
  const publish = (videos, source, extra = {}) => {
    videos = videos.filter(v => matchesQuickSubject(v, intention) && languageMatches(v.audio_language, preferences.languages)
      && v.duration_seconds >= preferences.minMinutes * 60 && v.duration_seconds <= preferences.maxMinutes * 60);
    if (!videos.length || signal?.aborted || enhanced) return;
    firstMs ??= Math.round(performance.now() - start);
    latest = { query: intention, preferences, videos, fetched_at: new Date().toISOString(), complete: false,
      provisional: true, provisional_source: source, quick_query: query, requests: 0, search_results: videos.length,
      timing_ms: { planning: 0, first_results: firstMs, total: Math.round(performance.now() - start) }, ...extra };
    onProgress(latest);
  };
  publish(cached, 'cache');
  const quickController = new AbortController();
  const cancel = () => { quickController.abort(); planningController.abort(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => quickController.abort(), quickTimeoutMs);
  const quick = (async () => {
    if (!query || !quickSubjectTerms(intention).length || quickController.signal.aborted) return;
    try {
      const token = await Promise.race([getQuickToken(), new Promise((_, reject) => {
        if (quickController.signal.aborted) reject(new LiveSearchError('CANCELLED'));
        else quickController.signal.addEventListener('abort', () => reject(new LiveSearchError('CANCELLED')), { once: true });
      })]);
      const result = await fetchYouTubeResults({ query, token, signal: quickController.signal, fetchImpl, preferences, timeoutMs: quickTimeoutMs });
      publish(result.videos, 'youtube', { requests: result.requests, search_results: result.search_results });
    } catch (error) {
      // Once the shared Google gate has refused this search, waiting for an AI
      // plan cannot produce fresh videos. Preserve cache and stop promptly.
      if (!quickController.signal.aborted && !enhanced
        && ['QUOTA_EXCEEDED', 'RATE_LIMITED', 'ACCESS_OR_QUOTA_DENIED'].includes(error?.code)) {
        stopForGoogle(error);
        planningController.abort();
      }
    }
    finally { clearTimeout(timer); }
  })();
  try {
    const result = await Promise.race([googleBlocked, discoverVideos({ intention, signal: planningController.signal, preferences, getToken, fetchImpl, watch,
      onStage: stage => { if (!planningController.signal.aborted) onStage(stage); },
      onProgress: partial => {
        if (planningController.signal.aborted || !partial.videos.length) return;
        enhanced = true; quickController.abort(); firstMs ??= Math.round(performance.now() - start);
        latest = { ...partial, quick_query: query, timing_ms: { ...partial.timing_ms, first_results: firstMs } };
        onProgress(latest);
      } })]);
    await quick;
    if (result.videos.length) return latest ?? result;
    if (latest?.videos.length) return { ...latest, complete: true, fallback: true };
    return result;
  } catch (error) {
    if (signal?.aborted || error?.code === 'CANCELLED') throw error;
    await quick;
    if (latest?.videos.length) return { ...latest, complete: true, fallback: true, warning: error?.code ?? 'REQUEST_FAILED' };
    throw error;
  } finally { clearTimeout(timer); quickController.abort(); planningController.abort(); signal?.removeEventListener('abort', cancel); }
}
