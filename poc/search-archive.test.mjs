import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchArchive, archiveRecommendations, cleanSearch } from './search-archive.mjs';

const now = Date.now();
const video = i => ({ video_id: String(i).padStart(11, '0'), title: `History ${i}`, channel: `Museum ${i}`,
  source: 'youtube_live', published_at: '2026-01-01', cachedAt: now, duration_seconds: 600 });
const record = i => ({ id: String(i), at: now, query: `My original request ${i}`, intention: `History ${i}`, videos: [video(i)] });
const memory = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }; };

test('archive keeps every search and result beyond the old 8-topic/40-video limits, reopening and clearing in order', async () => {
  const storage = memory(), archive = createSearchArchive({ storage });
  await Promise.all(Array.from({ length: 60 }, (_, i) => archive.put(record(i))));
  const large = { ...record(0), videos: Array.from({ length: 100 }, (_, i) => video(i)) };
  await archive.put(large);
  const reopened = createSearchArchive({ storage });
  const rows = await reopened.load();
  assert.equal(rows.length, 60); assert.equal(rows.find(r => r.id === '0').videos.length, 100);
  assert.equal(rows.find(r => r.id === '0').query, 'My original request 0');
  const pending = reopened.put(record(100)); const cleared = reopened.clear();
  await Promise.all([pending, cleared]); assert.deepEqual(await reopened.load(), []);
});

test('expired provider metadata is removed while original interests and result counts remain', () => {
  const old = cleanSearch({ ...record(1), count: 8 }, now + 31 * 86400000);
  assert.equal(old.query, 'My original request 1'); assert.equal(old.count, 8); assert.deepEqual(old.videos, []);
  assert.equal(archiveRecommendations([old]).length, 0);
});

test('recommendations mix interests and respect channel bans, hidden videos and channel diversity', () => {
  const rows = [record(1), { ...record(2), videos: [video(2), { ...video(3), channel: 'Museum 1' }, { ...video(4), channel: 'Museum 1' }] }];
  assert.deepEqual(archiveRecommendations(rows).map(v => v.video_id), [1, 2, 3].map(i => video(i).video_id));
  assert.deepEqual(archiveRecommendations(rows, { hidden: new Set([video(2).video_id]), allowed: v => v.channel !== 'Museum 1' }), []);
});

test('storage failure is reported rather than silently claiming the history was saved', async () => {
  let errors = 0;
  const archive = createSearchArchive({ storage: { getItem: () => null, setItem() { throw new Error('quota'); } }, onError: () => errors++ });
  await archive.put(record(1)); assert.equal(errors, 1);
});
