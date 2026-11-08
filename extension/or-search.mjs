import { normalizeSubject } from './direct-relevance.mjs';

// OR is one ranked result pool, not guaranteed quotas for each branch.
export function combineAngles(queries) {
  const angles = [];
  for (const value of queries) {
    const q = value.trim();
    if (!q || angles.some(a => normalizeSubject(a) === normalizeSubject(q))) continue;
    if ([...angles, q].join(' | ').length <= 300) angles.push(q);
    if (angles.length === 2) break;
  }
  return { query: angles.join(' | '), angles };
}

export function diversifyAngles(videos, angles) {
  const tokens = angles.map(q => [...new Set(normalizeSubject(q).split(' ').filter(w => w.length > 2))]);
  const bins = angles.map(() => []), unmatched = [];
  for (const video of videos) {
    const title = ` ${normalizeSubject(video.title)} `;
    const description = ` ${normalizeSubject(String(video.description ?? '').slice(0, 1500))} `;
    const scores = tokens.map(words => words.reduce((n, w) => n + (title.includes(` ${w} `) ? 2 : description.includes(` ${w} `) ? 1 : 0), 0) / Math.max(1, words.length));
    const best = Math.max(0, ...scores), index = scores.indexOf(best);
    if (!best) unmatched.push(video); // Missing lexical evidence is not proof of irrelevance.
    else bins[index].push({ ...video, discovery_query: angles[index] });
  }
  const rows = [];
  for (let i = 0; bins.some(b => i < b.length); i++) for (const bin of bins) if (bin[i]) rows.push(bin[i]);
  return [...rows, ...unmatched];
}
