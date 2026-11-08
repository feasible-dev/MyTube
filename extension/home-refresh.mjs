import { fetchYouTubeResults, LiveSearchError } from './youtube-live.mjs';
import { validDirectSubjects, matchesDirectSubject, validPlanText, PLAN_QUERY_PATTERN } from './direct-relevance.mjs';
import { validatePreferences } from './preferences.mjs';

// No AI or interactive sign-in. Two topics, one recent and one timeless search each.
export async function refreshHomeTopics({ topics, getToken, signal, onBatch = () => {}, fetchImpl = globalThis.fetch }) {
  if (!Array.isArray(topics) || topics.length > 2 || !topics.length) throw new LiveSearchError('INVALID_QUERY');
  for (const topic of topics) {
    if (!topic || typeof topic.label !== 'string' || topic.label.length > 120 || !Array.isArray(topic.queries) || !topic.queries.length
      || topic.queries.length > 4 || !topic.queries.every(q => validPlanText(q, PLAN_QUERY_PATTERN))
      || (topic.subjects?.length && !validDirectSubjects(topic.subjects))) throw new LiveSearchError('INVALID_QUERY');
    validatePreferences(topic.preferences);
  }
  if (signal?.aborted) throw new LiveSearchError('CANCELLED');
  const token = await getToken();
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  let requests = 0;
  try {
    // One worker per topic, stop the other worker too on quota or transport failure.
    const outcomes = await Promise.allSettled(topics.map(async topic => {
      try {
        for (const recent of [true, false]) {
          if (controller.signal.aborted) throw new LiveSearchError('CANCELLED');
          const query = topic.queries[recent ? 0 : Math.min(1, topic.queries.length - 1)];
          const result = await fetchYouTubeResults({ query, token, signal: controller.signal, fetchImpl, preferences: topic.preferences, recent });
          requests += result.requests;
          const videos = result.videos.filter(v => matchesDirectSubject(v, query, topic.subjects?.length ? topic.subjects : undefined))
            .map(v => ({ ...v, discovery_query: query }));
          if (!controller.signal.aborted) onBatch({ label: topic.label, videos, fetched_at: result.fetched_at });
        }
      } catch (error) { controller.abort(); throw error; }
    }));
    const failure = outcomes.find(o => o.status === 'rejected');
    if (failure) throw failure.reason;
    return { requests };
  } finally { signal?.removeEventListener('abort', cancel); controller.abort(); }
}
