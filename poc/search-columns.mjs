import { selectSearchColumns } from './model.mjs';

// Keep arrival positions even when a filter temporarily removes a video.
// Updated metadata comes from the latest candidates, never an older snapshot.
export function projectOrderedVideos(candidates, previousOrder = [], limit = 8) {
  const byId = new Map(candidates.map(video => [video.video_id, video]));
  const order = [...previousOrder], seen = new Set(order);
  for (const video of candidates) {
    if (!seen.has(video.video_id)) { order.push(video.video_id); seen.add(video.video_id); }
  }
  return { order, rows: order.filter(id => byId.has(id)).slice(0, limit).map(id => byId.get(id)) };
}

// Keep the first two columns stable; late external discoveries rise in column 3.
export function projectSearchColumns(candidates, previousOrder = {}, limit = 8) {
  const orderByColumn = Object.fromEntries(Object.entries(previousOrder).map(([key, ids]) => [key, [...ids]]));
  // Late arrivals in another column must not change which existing cards win
  // the per-creator caps. Keep the established order before selecting again.
  const stableCandidates = ['direct', 'adjacent', 'wildcard'].flatMap(stream => {
    const column = stream === 'adjacent' ? 'related' : stream;
    const prior = new Map((orderByColumn[column] ?? []).map((id, index) => [id, index]));
    return candidates.filter(v => v.discovery_stream === stream).sort((a, b) => (prior.get(a.video_id) ?? Infinity) - (prior.get(b.video_id) ?? Infinity));
  });
  const selected = selectSearchColumns(stableCandidates, true, 50);
  const rows = Object.fromEntries(['direct', 'related', 'wildcard'].map(column => {
    const projected = projectOrderedVideos(selected[column], column === 'wildcard' ? [] : orderByColumn[column], limit);
    orderByColumn[column] = projected.order;
    return [column, projected.rows];
  }));
  const count = rows.direct.length + rows.related.length + rows.wildcard.length;
  return { rows, selected, count, order: orderByColumn };
}
