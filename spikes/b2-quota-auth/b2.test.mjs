import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateSearch, estimateChannels, capacity } from './model.mjs';
import { client, sampleFeeds } from './public-feed.mjs';

test('B1-based search projections respect separate quota buckets and headroom', () => {
  assert.deepEqual(estimateSearch({ users: 20, intentionsPerDay: 1 }), { search: 80, other: 40 });
  assert.equal(capacity(estimateSearch({ users: 20, intentionsPerDay: 1 })).fits_with_reserve, true);
  assert.equal(capacity(estimateSearch({ users: 5, intentionsPerDay: 5 })).fits_with_reserve, false);
  assert.equal(capacity(estimateSearch({ users: 5, intentionsPerDay: 5 })).fits_documented_defaults, true);
  assert.equal(capacity(estimateSearch({ users: 20, intentionsPerDay: 5 })).fits_documented_defaults, false);
  assert.deepEqual(estimateSearch({ users: 20, intentionsPerDay: 5, cacheHitRate: 0.8 }), { search: 80, other: 40 });
});
test('channel refresh accounts for pagination, batched metadata, and cached IDs', () => {
  assert.deepEqual(estimateChannels({ users: 20, channelsPerUser: 20 }), { search: 0, other: 840 });
  assert.deepEqual(estimateChannels({ users: 20, channelsPerUser: 20, metadataVideosPerChannel: 2, cachedChannelIds: true }), { search: 0, other: 440 });
  assert.equal(estimateChannels({ users: 1, channelsPerUser: 51 }).other, 106);
  assert.equal(capacity(estimateChannels({ users: 20, channelsPerUser: 200, refreshesPerDay: 2 })).fits_documented_defaults, false);
});
test('invalid assumptions fail instead of producing optimistic capacity', () => {
  for (const users of [-1, 0.5, NaN, Infinity]) assert.throws(() => estimateSearch({ users, intentionsPerDay: 1 }));
  assert.throws(() => estimateSearch({ users: 20, intentionsPerDay: 1, cacheHitRate: 1.1 }));
  assert.throws(() => estimateChannels({ users: 20, channelsPerUser: -1 }));
});
const key = 'synthetic_test_key_canary_12345';
const json = (data, init = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, ...init });
test('public-feed client restricts origin, endpoints, parameters and per-endpoint budgets', async () => {
  const ledger = [];
  const request = client(key, ledger, async (url, options) => {
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.ok(!url.href.includes(key));
    assert.equal(options.headers['x-goog-api-key'], key);
    assert.equal(options.redirect, 'error');
    return json({ items: [] });
  });
  for (const [endpoint, max] of [['videos', 4], ['channels', 1], ['playlistItems', 3]]) {
    for (let i = 0; i < max; i++) await request(endpoint, {});
    await assert.rejects(request(endpoint, {}), /REQUEST_BUDGET_EXCEEDED/);
  }
  await assert.rejects(request('search', {}), /INVALID_ENDPOINT/);
  await assert.rejects(request('videos', { pageToken: 'next' }), /INVALID_PARAMETER/);
  assert.equal(ledger.length, 8);
  assert.ok(!JSON.stringify(ledger).includes(key));
});
test('feed client sanitizes errors and refuses oversized or malformed responses', async () => {
  for (const response of [json({ error: key }, { status: 403 }), json({ items: [], echo: key }),
    json({ items: Array(51).fill({}) }), new Response('oops', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(client(key, [], async () => response)('videos', {}), error => !String(error).includes(key));
  }
  await assert.rejects(client(key, [], async () => { throw new Error(key); })('videos', {}), /NETWORK_ERROR/);
});
const seeds = ['aviation', 'mathematics', 'history'].map((intent, i) => ({ intent, video_id: String(i).padStart(11, '0') }));
const intents = seeds.map(s => ({ id: s.intent, min_minutes: 20, max_minutes: 90 }));
test('three public channel feeds use at most eight calls, deduplicate and retain unknown metadata', async () => {
  const calls = [];
  const request = async (endpoint, params) => {
    calls.push(endpoint);
    if (endpoint === 'videos' && params.part === 'snippet') return seeds.map((s, i) => ({ id: s.video_id, snippet: { channelId: 'UC' + String(i).padStart(22, '0') } }));
    if (endpoint === 'channels') return params.id.split(',').map(id => ({ id, contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } } }));
    if (endpoint === 'playlistItems') {
      const base = Number(params.playlistId.slice(-1)) * 50;
      return Array.from({ length: 50 }, (_, i) => ({ contentDetails: { videoId: String(base + i + 100).padStart(11, '0') } }));
    }
    return params.id.split(',').filter(id => !id.endsWith('100')).map(id => ({ id, contentDetails: { duration: 'PT30M' }, snippet: { liveBroadcastContent: 'none' } }));
  };
  const result = await sampleFeeds(seeds, intents, [], request);
  assert.equal(calls.length, 8);
  assert.ok(!calls.includes('search'));
  assert.equal(result.unique_playlist_video_ids, 150);
  assert.equal(result.missing_metadata_count, 1);
  assert.equal(result.samples[0].eligible_by_duration_and_live_status, 49);
  assert.equal(result.samples[0].relevance, 'UNASSESSED');
});
test('missing seeds stop before channel/feed calls and unrequested IDs fail closed', async () => {
  let calls = 0;
  await assert.rejects(sampleFeeds(seeds, intents, [], async () => { calls++; return []; }), /SEED_UNAVAILABLE/);
  assert.equal(calls, 1);
  await assert.rejects(sampleFeeds(seeds, intents, [], async () => [{ id: 'not_allowed' }]), /INVALID_SEED_RESPONSE/);
});
