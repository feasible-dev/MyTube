import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyYouTube } from './youtube-key.mjs';
import { startConnector, EXTENSION_ID } from './server.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';

const key = 'SYNTHETIC_PRIVATE_KEY_ONLY_IN_TESTS_12345';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const row = { id: 'abcdefghijk', snippet: { title: 'Maya archaeology', channelTitle: 'Museum', description: 'Archaeology',
  channelId: 'UC' + 'a'.repeat(22), defaultAudioLanguage: 'en', publishedAt: '2024-01-01T00:00:00Z', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT35M' }, statistics: { viewCount: '123' } };

test('YouTube key goes only in the Google HTTPS header; results contain metadata, never credentials', async () => {
  const calls = [];
  const youtube = createKeyYouTube({ getKey: async () => key, fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(new URL(url).origin, 'https://www.googleapis.com'); assert.ok(!url.includes(key));
    assert.equal(init.headers['X-Goog-Api-Key'], key); assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    if (url.includes('/channels?')) return json({ items: [{ id: row.snippet.channelId, snippet: { thumbnails: { default: { url: 'https://yt3.ggpht.com/test-avatar' } } } }] });
    return json({ items: url.includes('/search?') ? [{ id: { videoId: row.id } }] : [row] });
  } });
  assert.equal(await youtube.configured(), true); assert.equal(calls.length, 0);
  const result = await youtube.search('Maya', defaultPreferences());
  assert.equal(calls.length, 3); assert.equal(result.videos[0].duration_seconds, 2100);
  assert.equal(result.videos[0].channel_avatar, 'https://yt3.ggpht.com/test-avatar');
  assert.ok(!JSON.stringify(result).includes(key));
  const second = await youtube.search('Maya temples', defaultPreferences());
  assert.equal(second.videos[0].channel_avatar, result.videos[0].channel_avatar);
  assert.equal(calls.length, 5, 'The next search reuses the channel logo without another channels request');
});
test('provider key echoes and provider exceptions cannot escape through local HTTP', async () => {
  let mode = 'error';
  const youtube = createKeyYouTube({ getKey: async () => key, fetchImpl: async () => {
    if (mode === 'error') throw new Error(key);
    if (mode === 'escaped') return new Response(`{"items":[],"private":"${[...key].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}"}`, { headers: { 'content-type': 'application/json' } });
    if (mode === 'quota') return json({ error: { message: key, errors: [{ reason: 'quotaExceeded' }] } }, 403);
    return json({ items: [], private: key });
  } });
  const server = await startConnector({ port: 0, youtube, signOut: async () => {} });
  const headers = { Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', 'X-MyTube-Request': crypto.randomUUID() };
  const post = (body, extra = {}, route = 'search') => fetch(`http://127.0.0.1:${server.port}/youtube/${route}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ query: 'Maya' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ query: 'Maya' }, { 'X-MyTube-Request': 'bad' })).status, 400);
    assert.equal((await post({ query: 'Maya', endpoint: 'https://evil.example' })).status, 400);
    assert.equal((await post({ ids: Array(51).fill(row.id) }, {}, 'durations')).status, 400);
    assert.deepEqual(await (await post({}, {}, 'status')).json(), { configured: true });
    for (mode of ['error', 'echo', 'escaped', 'quota']) {
      const response = await post({ query: 'Maya' }); const body = await response.text();
      assert.equal(response.status, 400); assert.ok(!body.includes(key));
      assert.equal(JSON.parse(body).error, mode === 'error' ? 'REQUEST_FAILED' : mode === 'quota' ? 'QUOTA_EXCEEDED' : 'INVALID_RESPONSE');
    }
  } finally { await server.close(); }
});
test('missing key never initiates any provider call', async () => {
  const youtube = createKeyYouTube({ getKey: async () => null, fetchImpl: () => assert.fail('No credential') });
  assert.equal(await youtube.configured(), false);
  await assert.rejects(youtube.search('Maya', defaultPreferences()), { message: 'YOUTUBE_KEY_MISSING' });
});
test('another local install must explicitly pin its own extension ID', async () => {
  const extensionId = 'a'.repeat(32);
  const server = await startConnector({ port: 0, extensionId, signOut: async () => {}, youtube: { configured: async () => false } });
  const post = origin => fetch(`http://127.0.0.1:${server.port}/youtube/status`, { method: 'POST', body: '{}',
    headers: { Origin: `chrome-extension://${origin}`, 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', 'X-MyTube-Request': crypto.randomUUID() } });
  try {
    assert.equal((await post(EXTENSION_ID)).status, 403);
    assert.deepEqual(await (await post(extensionId)).json(), { configured: false });
  } finally { await server.close(); }
});
