import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverWebVideos, validateWebVideos } from './web-discovery.mjs';
const video = { video_id: 'abcdefghijk', title: 'Maya archaeology', channel: 'Museum', source: 'youtube_web',
  source_url: 'https://www.youtube.com/watch?v=abcdefghijk', duration_seconds: null, published_at: null, views: null,
  discovery_stream: 'direct', discovery_why: 'Archaeological evidence' };
test('web discovery needs only the local connector and delivers verified tiles without Google authorization', async () => {
  const urls = [], updates = [];
  const result = await discoverWebVideos({ intention: 'Maya archaeology', onProgress: r => updates.push(r), fetchImpl: async (url, init) => {
    urls.push(url); assert.equal(init.headers.Authorization, undefined);
    assert.equal(JSON.parse(init.body).intention, 'Maya archaeology');
    return new Response(JSON.stringify({ searches: 1, videos: [video] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(urls, ['http://127.0.0.1:43817/web-discover']);
  assert.equal(result.provider, 'chatgpt_web'); assert.equal(result.requests, 0); assert.equal(result.complete, true);
  assert.equal(result.streams.direct.videos.length, 1); assert.equal(updates.length, 1);
});
test('web metadata cannot inject remote links, invented counts or duplicates into the browser', () => {
  for (const changed of [{ source_url: 'https://evil.example' }, { duration_seconds: 1200 }, { views: 999 }, { title: '' }])
    assert.throws(() => validateWebVideos({ searches: 1, videos: [{ ...video, ...changed }] }));
  assert.throws(() => validateWebVideos({ searches: 1, videos: [video, video] }));
});

test('unusable web sources get one automatic correction without changing the original request', async () => {
  const bodies = [];
  const result = await discoverWebVideos({ intention: 'Maya archaeology', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? new Response(JSON.stringify({ error: 'WEB_SEARCH_NO_SOURCED_VIDEOS' }), { status: 400, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ searches: 1, videos: [video] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(bodies.map(b => b.intention), ['Maya archaeology', 'Maya archaeology']);
  assert.equal(bodies[1].recovery, 'NO_RESULTS');
  assert.equal(result.adjustments[0].reason, 'WEB_SEARCH_NO_SOURCED_VIDEOS');
  let calls = 0;
  await assert.rejects(discoverWebVideos({ intention: 'Maya archaeology', fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ error: 'WEB_SEARCH_NO_SOURCED_VIDEOS' }), { status: 400, headers: { 'content-type': 'application/json' } });
  } }), { code: 'WEB_SEARCH_NO_SOURCED_VIDEOS' });
  assert.equal(calls, 2);
});

test('streamed videos render before completion and survive a later provider failure', async () => {
  let stream, finish, published;
  const gotFirst = new Promise(resolve => { published = resolve; });
  const encoder = new TextEncoder(), updates = [];
  const pending = discoverWebVideos({ intention: 'Maya archaeology',
    onProgress: r => { updates.push(r); published(); },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Accept, 'application/x-ndjson');
      return new Response(new ReadableStream({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', searches: 1, videos: [video] }) + '\n'));
      } }), { headers: { 'content-type': 'application/x-ndjson' } });
    },
  }).then(value => { finish = value; return value; });
  await gotFirst;
  assert.equal(finish, undefined); assert.equal(updates[0].complete, false);
  assert.equal(updates[0].streams.direct.videos.length, 1);
  stream.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: 'CHATGPT_UNAVAILABLE' }) + '\n')); stream.close();
  const result = await pending;
  assert.equal(result.videos[0].video_id, video.video_id); assert.equal(result.warning, 'CHATGPT_UNAVAILABLE');
});
