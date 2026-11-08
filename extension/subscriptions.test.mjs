import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSubscriptionPage } from './subscriptions.mjs';
import { defaultPreferences } from './preferences.mjs';

const channel = 'UC' + 'a'.repeat(22), id = 'abcdefghijk';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('subscriptions use authenticated account, uploads and real metadata; page token and batches are preserved', async () => {
  const requests = [], batches = [];
  const result = await fetchSubscriptionPage({ token: 'SYNTHETIC_TEST_TOKEN_12345', pageToken: 'PAGE_TWO', preferences: defaultPreferences(), onBatch: v => batches.push(v),
    fetchImpl: async (url, options) => {
      const u = new URL(url), path = u.pathname.split('/').at(-1); requests.push(path);
      assert.equal(options.headers.Authorization, 'Bearer SYNTHETIC_TEST_TOKEN_12345'); assert.equal(options.credentials, 'omit');
      if (path === 'subscriptions') { assert.equal(u.searchParams.get('mine'), 'true'); assert.equal(u.searchParams.get('pageToken'), 'PAGE_TWO'); return json({ items: [{ snippet: { resourceId: { channelId: channel } } }], nextPageToken: 'PAGE_THREE' }); }
      if (path === 'channels') return json({ items: [{ id: channel, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } }] });
      if (path === 'playlistItems') return json({ items: [{ contentDetails: { videoId: id } }] });
      assert.equal(path, 'videos'); return json({ items: [{ id, snippet: { channelId: channel, channelTitle: 'Museum', title: 'History', publishedAt: '2026-11-01', liveBroadcastContent: 'none', defaultAudioLanguage: 'en' }, contentDetails: { duration: 'PT25M' }, statistics: { viewCount: '1234' } }] });
    } });
  assert.deepEqual(requests, ['subscriptions', 'channels', 'playlistItems', 'videos']);
  assert.equal(result.nextPageToken, 'PAGE_THREE'); assert.equal(batches.length, 1);
  assert.equal(result.videos[0].duration_seconds, 1500); assert.equal(result.videos[0].views, 1234);
});

test('a cancelled subscriptions request publishes no videos', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchSubscriptionPage({ token: 'SYNTHETIC_TEST_TOKEN_12345', signal: controller.signal,
    fetchImpl: () => assert.fail('No request after cancellation'), onBatch: () => assert.fail('No publication') }), { code: 'CANCELLED' });
});
