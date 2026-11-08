import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOrderedVideos, projectSearchColumns } from './search-columns.mjs';

test('late alternative discoveries rise above YouTube without moving the direct column', () => {
  const yt = Array.from({ length: 10 }, (_, i) => ({ video_id: `yt${i}`, title: `Film ${i}`, channel: `Creator ${i}`, discovery_stream: 'wildcard' }));
  const direct = { video_id: 'direct', title: 'Direct', channel: 'Direct', discovery_stream: 'direct' };
  const first = projectSearchColumns([direct, ...yt]);
  const external = ['BitChute', 'Rumble', 'Rutube', 'Odysee'].map(platform => ({ video_id: platform, title: platform, platform, channel_unknown: true, discovery_stream: 'wildcard' }));
  const next = projectSearchColumns([direct, ...yt, ...external], first.order);
  assert.deepEqual(next.rows.wildcard.slice(0, 4).map(v => v.platform), ['BitChute', 'Rumble', 'Rutube', 'Odysee']);
  assert.deepEqual(next.rows.direct, first.rows.direct);
  assert.equal(next.selected.wildcard.length, 14);
});

test('filtered videos regain their arrival positions while new metadata and late results are retained', () => {
  const original = [{ video_id: 'a', title: 'Old title' }, { video_id: 'b' }];
  const first = projectOrderedVideos(original);
  const filtered = projectOrderedVideos([{ video_id: 'c' }, original[1]], first.order);
  assert.deepEqual(filtered.rows.map(video => video.video_id), ['b', 'c']);
  const updated = { video_id: 'a', title: 'Corrected title', duration_seconds: 1800 };
  const restored = projectOrderedVideos([{ video_id: 'c' }, updated, original[1]], filtered.order);
  assert.deepEqual(restored.rows.map(video => video.video_id), ['a', 'b', 'c']);
  assert.equal(restored.rows[0], updated);
  assert.deepEqual(first.order, ['a', 'b']);
  assert.equal(original[0].title, 'Old title');
});

test('revealing another page keeps its established order and shows a duplicate ID once with current metadata', () => {
  const candidates = Array.from({ length: 18 }, (_, index) => ({ video_id: String(index) }));
  const first = projectOrderedVideos(candidates, [], 8);
  assert.equal(first.rows.length, 8);
  assert.equal(first.order.length, 18);
  const replacement = { video_id: '2', title: 'Latest metadata' };
  const next = projectOrderedVideos([...candidates].reverse().concat(replacement), first.order, 16);
  assert.deepEqual(next.rows.map(video => video.video_id), candidates.slice(0, 16).map(video => video.video_id));
  assert.equal(next.rows[2], replacement);
  assert.deepEqual(next.order, first.order);
  assert.notEqual(next.order, first.order);
});
