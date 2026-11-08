import { matchesQuickSubject } from '../extension/quick-relevance.mjs';
import { STREAMS, selectSearchColumns, syntheticProductionSignals } from '../poc/model.mjs';

// One bounded metadata queue is shared by early sources and the final selection.
export function createWebProgress({ intention, signal, metadata, publish, onTarget = () => {} }) {
  const pending = new Map(), queue = [], visible = new Map(), observed = new Map();
  let workers = 0, previews = 0, closed = false, latestSearches = 1, targetNotified = false;
  const displayable = rows => {
    const eligible = rows.filter(v => !syntheticProductionSignals(v).length);
    const originals = new Map(eligible.map(v => [v.video_id, v]));
    return Object.values(selectSearchColumns(eligible.map(v => ({ ...v, discovery_query: v.discovery_why })))).flat().map(v => originals.get(v.video_id));
  };
  const pump = () => {
    while (!closed && workers < 4 && queue.length) {
      const job = queue.shift(); workers++;
      Promise.resolve().then(() => signal.aborted ? [] : metadata([job.pick], signal))
        .then(rows => job.resolve(rows[0] ?? null), () => job.resolve(null))
        .finally(() => { workers--; pump(); });
    }
  };
  function load(pick) {
    if (!pending.has(pick.video_id)) {
      if (pending.size >= 132) return Promise.resolve(null);
      pending.set(pick.video_id, new Promise(resolve => queue.push({ pick, resolve }))); pump();
    }
    return pending.get(pick.video_id).then(row => row && ({ ...row,
      discovery_stream: pick.stream, discovery_why: pick.why }));
  }
  return {
    counts() {
      const rows = displayable([...visible.values()]);
      return Object.fromEntries(STREAMS.map(stream => [stream, rows.filter(v => v.discovery_stream === stream).length]));
    },
    observe({ picks, searches, selected = false }) {
      if (closed || signal.aborted) return;
      latestSearches = Math.max(latestSearches, searches);
      for (const pick of picks) {
        const signature = JSON.stringify([pick.stream, pick.why, selected]);
        if (observed.get(pick.video_id) === signature) continue;
        if (!selected && (previews >= 12 || pending.has(pick.video_id))) continue;
        if (!selected) previews++;
        observed.set(pick.video_id, signature);
        load(pick).then(row => {
          if (!row || closed || signal.aborted || observed.get(pick.video_id) !== signature || (!selected && !matchesQuickSubject(row, intention))) return;
          visible.set(row.video_id, row);
          const videos = displayable([...visible.values()]);
          publish({ type: 'progress', videos, searches: latestSearches });
          if (videos.length === 16 && !targetNotified) { targetNotified = true; closed = true; onTarget(); }
        });
      }
    },
    async finish(picks) {
      if (targetNotified) return displayable([...visible.values()]);
      const rows = await Promise.all(picks.map(load)); closed = true;
      const final = new Map(rows.filter(Boolean).map(v => [v.video_id, v]));
      const order = [...new Set([...visible.keys(), ...final.keys()])];
      return displayable(order.filter(id => final.has(id)).map(id => final.get(id)));
    },
    close() { closed = true; },
  };
}
