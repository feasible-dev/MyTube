import { createWebDiscoveryTask } from './web-task.mjs';

// The subject and mixed related-topic columns start together.
// Follow up only underfilled columns, counting verified, displayable videos.
export async function runWebStages({ intention, preferences, recovery, signal, run, publish = () => {}, getCounts, now = Date.now }) {
  const selections = new Map(), searches = new Map(), started = now();
  const totalSearches = () => Math.max(1, [...searches.values()].reduce((a, b) => a + b, 0));
  const streams = ['direct', 'adjacent', 'wildcard'];
  const counts = () => getCounts?.() ?? Object.fromEntries(streams.map(stream => [stream, [...selections.values()].filter(v => v.stream === stream).length]));
  for (let wave = 0; wave < 6; wave++) {
    if (signal?.aborted) {
      if (signal.reason?.message === 'COLLECTION_COMPLETE') break;
      throw signal.reason;
    }
    if (wave && now() - started >= 180000) break;
    const ready = counts();
    const remaining = { direct: 8 - ready.direct, related: 8 - ready.adjacent - ready.wildcard };
    const missing = ['direct', 'related'].filter(column => remaining[column] > 0);
    if (!missing.length || selections.size >= 120) break;
    const excluded = [...selections.keys()];
    const tasks = missing.map(stream => {
      const key = `${wave}:${stream}`;
      const merge = picks => {
        for (const video of picks) {
          const previous = selections.get(video.video_id);
          if ((!previous && selections.size < 120) || (previous && streams.indexOf(video.stream) < streams.indexOf(previous.stream))) selections.set(video.video_id, video);
        }
      };
      return createWebDiscoveryTask(intention, value => {
        merge(value.videos); searches.set(key, value.searches);
        publish({ picks: [...selections.values()], searches: totalSearches(), selected: true });
      }, preferences, recovery, update => {
        searches.set(key, update.searches);
        if (update.selected) {
          merge(update.picks);
          publish({ picks: [...selections.values()], searches: totalSearches(), selected: true });
        } else publish({ ...update, searches: totalSearches() });
      }, stream, excluded, { round: wave + 1, remaining: remaining[stream], wildcards: ready.wildcard, nearby: ready.adjacent });
    });
    try { await run({ tasks, accept() {} }); }
    catch (error) {
      if (signal?.aborted && signal.reason?.message === 'COLLECTION_COMPLETE') break;
      if (signal?.aborted || !['INVALID_SEARCH_PLAN', 'WEB_SEARCH_NO_SOURCED_VIDEOS', 'WEB_SEARCH_LIMIT_REACHED', 'CHATGPT_RESPONSE_INCOMPLETE', 'CHATGPT_TIMEOUT'].includes(error.message)) throw error;
    }
  }
  return { videos: [...selections.values()].sort((a, b) => streams.indexOf(a.stream) - streams.indexOf(b.stream)), searches: totalSearches() };
}
