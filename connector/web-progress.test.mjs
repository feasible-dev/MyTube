import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebProgress } from './web-progress.mjs';

test('early sources are verified, subject-filtered and reused by the final selection', async () => {
  const updates = [], calls = [];
  const feed = createWebProgress({ intention: 'Mayas', signal: new AbortController().signal,
    metadata: async ([p]) => { calls.push(p.video_id); return [{ video_id: p.video_id,
      title: p.video_id === 'abcdefghijk' ? 'Maya archaeology' : 'Unrelated action movie' }]; },
    publish: value => updates.push(value),
  });
  const picks = ['abcdefghijk', 'lmnopqrstuv'].map(video_id => ({ video_id, stream: 'direct', why: 'Early result' }));
  feed.observe({ picks, searches: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates.at(-1).videos.map(v => v.video_id), ['abcdefghijk']);
  const final = await feed.finish([{ ...picks[0], why: 'Final explanation' }]);
  assert.equal(calls.length, 2); assert.equal(final[0].discovery_why, 'Final explanation');
});

test('metadata verification stays at four workers and cancellation stops publication', async () => {
  let active = 0, peak = 0; const releases = [], controller = new AbortController();
  const feed = createWebProgress({ intention: 'Maya', signal: controller.signal,
    metadata: async ([p]) => { active++; peak = Math.max(peak, active); await new Promise(r => releases.push(r)); active--; return [{ video_id: p.video_id, title: 'Maya' }]; },
    publish: () => assert.fail('No late publication'),
  });
  feed.observe({ picks: Array.from({ length: 12 }, (_, i) => ({ video_id: String(i).padStart(11, '0'), stream: 'direct', why: '' })), searches: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 4); controller.abort(); releases.forEach(r => r());
  await feed.finish([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 4);
});

test('refill counts verified diverse videos, not removed links or duplicate channels', async () => {
  const feed = createWebProgress({ intention: 'History', signal: new AbortController().signal,
    metadata: async ([p]) => p.video_id === '00000000000' ? [] : [{ video_id: p.video_id, title: `History ${p.video_id}`, channel: 'Same channel' }],
    publish() {},
  });
  const picks = Array.from({ length: 20 }, (_, i) => ({ video_id: String(i).padStart(11, '0'), stream: 'direct', why: 'History' }));
  feed.observe({ picks, searches: 2, selected: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(feed.counts(), { direct: 2, adjacent: 0, wildcard: 0 });
  assert.equal((await feed.finish(picks)).length, 2);
});

test('after sixteen eligible videos completion does not wait for an unused slow candidate', async () => {
  let release, reached = 0;
  const slow = new Promise(resolve => { release = resolve; });
  const feed = createWebProgress({ intention: 'History', signal: new AbortController().signal, onTarget: () => reached++, publish() {},
    metadata: async ([pick]) => {
      if (pick.video_id === '00000000008') await slow;
      return [{ video_id: pick.video_id, title: `History ${pick.video_id}`, channel: `Channel ${pick.video_id}` }];
    },
  });
  const picks = Array.from({ length: 17 }, (_, i) => ({ video_id: String(i).padStart(11, '0'), stream: i < 9 ? 'direct' : i < 14 ? 'adjacent' : 'wildcard', why: `Angle ${i}` }));
  try {
    feed.observe({ picks, searches: 4, selected: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reached, 1);
    let finished = false;
    const done = feed.finish(picks).then(rows => { finished = true; return rows; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, true); assert.equal((await done).length, 16);
  } finally { release(); feed.close(); }
});
