import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoDurations } from './video-durations.mjs';

const id = n => String(n).padStart(11, '0');
const unknown = n => ({ video_id: id(n), duration_seconds: null });

test('duration enrichment batches unique IDs and never repeats attempted lookups', async () => {
  const calls = [];
  const durations = createVideoDurations({ generation: () => 0, load: async ids => {
    calls.push(ids);
    return ids.map(video_id => ({ video_id, duration_seconds: 1800 }));
  } });
  const candidates = ['invalid', ...Array.from({ length: 55 }, (_, n) => id(n)), id(0)];
  assert.equal(await durations.enrich(candidates), true);
  assert.equal(calls[0].length, 50);
  assert.equal(await durations.enrich(candidates), true);
  assert.equal(calls[1].length, 5);
  assert.equal(await durations.enrich(candidates), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(durations.apply(unknown(54)), { video_id: id(54), duration_seconds: 1800, duration_source: 'youtube_api' });
});

test('only requested valid durations enrich unknown metadata; known durations are preserved', async () => {
  const durations = createVideoDurations({ generation: () => 0,
    videos: [{ video_id: id(9), duration_seconds: 60, duration_source: 'youtube_api' }],
    load: async () => [
      { video_id: id(0), duration_seconds: 120 },
      { video_id: id(1), duration_seconds: 0 },
      { video_id: id(2), duration_seconds: 21601 },
      { video_id: id(3), duration_seconds: 1.5 },
      { video_id: id(4), duration_seconds: '120' },
      { video_id: id(5), duration_seconds: 120 },
    ] });
  await durations.enrich([0, 1, 2, 3, 4].map(id));
  assert.equal(durations.apply(unknown(0)).duration_seconds, 120);
  for (const n of [1, 2, 3, 4, 5]) {
    const video = unknown(n);
    assert.equal(durations.apply(video), video);
  }
  assert.equal(durations.apply(unknown(9)).duration_seconds, 60);
  const known = { video_id: id(0), duration_seconds: 90 };
  assert.equal(durations.apply(known), known);
});

test('history invalidation and provider failure cannot publish late metadata', async () => {
  let epoch = 0, resolve;
  const durations = createVideoDurations({ generation: () => epoch,
    load: () => new Promise(done => { resolve = done; }) });
  const pending = durations.enrich([id(0)]);
  epoch++;
  resolve([{ video_id: id(0), duration_seconds: 120 }]);
  assert.equal(await pending, false);
  assert.equal(durations.apply(unknown(0)).duration_seconds, null);
  let calls = 0;
  const failed = createVideoDurations({ generation: () => 0, load: async () => {
    calls++; throw new Error('unavailable');
  } });
  assert.equal(await failed.enrich([id(0)]), false);
  assert.equal(await failed.enrich([id(0)]), false);
  assert.equal(calls, 1);
});
