import test from 'node:test';
import assert from 'node:assert/strict';
import { saveLastSearch, loadLastSearch, clearLastSearch } from './last-search-store.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';

test('last page retains partial columns, order and reveal limit with bounded public fields', () => {
  const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }, now = Date.now();
  const videos = ['direct', 'adjacent', 'wildcard'].map((discovery_stream, i) => ({
    video_id: String(i).padStart(11, '0'), title: `History ${i}`, channel: `Museum ${i}`, source: 'youtube_live',
    duration_seconds: 1800, published_at: '2024-01-01', discovery_stream, privateField: 'synthetic-do-not-store',
  }));
  saveLastSearch(storage, { query: 'Conversos', videos, provider: 'youtube_api', interrupted: true,
    preferences: defaultPreferences(), limit: 24, order: { direct: [videos[0].video_id] } }, true, now);
  const page = loadLastSearch(storage, true, now + 10);
  assert.deepEqual(page.videos.map(v => v.discovery_stream), ['direct', 'adjacent', 'wildcard']);
  assert.equal(page.query, 'Conversos'); assert.equal(page.interrupted, true); assert.equal(page.limit, 24);
  assert.deepEqual(page.order.direct, [videos[0].video_id]); assert.ok(![...data.values()][0].includes('synthetic-do-not-store'));
  assert.equal(loadLastSearch(storage, true, now + 31 * 86400000), null);
  assert.equal(loadLastSearch(storage, false, now), null); assert.equal(loadLastSearch(storage, true, now), null);
  clearLastSearch(storage);
  data.set('mytube.last-search.v1', '{broken'); assert.equal(loadLastSearch(storage, true, now), null);
  assert.doesNotThrow(() => saveLastSearch({ setItem() { throw Error('full'); } }, {}, true));
});
