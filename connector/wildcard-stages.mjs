import { createWildcardTask } from './wildcard-task.mjs';
import { Failure } from '../spikes/a1-openai-login/protocol.mjs';

// Dedicated alternative-platform groups, at most two web searches each. Both start even when
// the first group is prolific; neither group can silently skip the other.
export async function runWildcardStages({ intention, preferences, signal, run, publish = () => {} }) {
  if (signal?.aborted) throw new Failure('CANCELLED');
  const groups = [['BitChute'], ['Rumble'], ['Rutube'], ['Odysee', 'Internet Archive', 'Vimeo', 'Dailymotion']];
  const picks = new Map(), counts = groups.map(() => 0), details = groups.map(() => []);
  const total = () => Math.max(1, counts.reduce((a, b) => a + b, 0));
  const report = (index, batch) => {
    counts[index] = Math.max(counts[index], batch.searches ?? 1);
    if (batch.search_details) details[index] = batch.search_details;
    for (const pick of batch.picks ?? []) picks.set(pick.video_id, pick);
    publish({ ...batch, searches: total(), search_details: groups.flatMap((platforms, i) =>
      details[i].map(item => ({ ...item, platforms }))) });
  };
  const tasks = groups.map((platforms, index) => createWildcardTask(intention,
    result => report(index, { picks: result.videos, searches: result.searches }), preferences,
    batch => report(index, batch), [], platforms));
  // The session owns concurrency, authentication and fatal-error cancellation.
  // Calling session.plan twice would make the second lane fail CONNECTOR_BUSY.
  try { await run({ tasks, accept() {} }); }
  catch (error) {
    if (signal?.aborted || !['INVALID_SEARCH_PLAN', 'WEB_SEARCH_NO_SOURCED_VIDEOS', 'WEB_SEARCH_LIMIT_REACHED', 'CHATGPT_RESPONSE_INCOMPLETE', 'CHATGPT_REFUSED', 'CHATGPT_TIMEOUT'].includes(error.message)) throw error;
    if (!picks.size) throw error;
  }
  if (signal?.aborted) throw new Failure('CANCELLED');
  if (!picks.size) throw new Failure('WEB_SEARCH_NO_SOURCED_VIDEOS');
  return { videos: [...picks.values()], searches: total() };
}
