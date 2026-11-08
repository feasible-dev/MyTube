import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeRequest, executeYouTubeRequest } from './youtube-requests.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';

test('YouTube request validation rejects unknown operations, extra fields and out-of-bounds inputs', () => {
  for (const body of [null, [], 'text', 1, true]) {
    for (const path of ['/youtube/status', '/youtube/search', '/youtube/durations']) assert.equal(parseYouTubeRequest(path, body), null);
  }
  for (const [path, body] of [
    ['/youtube/other', {}], ['/youtube/status', { extra: true }],
    ['/youtube/search', {}], ['/youtube/search', { query: ' ' }],
    ['/youtube/search', { query: 'x'.repeat(301) }], ['/youtube/search', { query: 'x\ny' }],
    ['/youtube/search', { query: 'History', url: 'https://example.com' }],
    ['/youtube/durations', { ids: [] }], ['/youtube/durations', { ids: ['invalid'] }],
    ['/youtube/durations', { ids: Array(51).fill('abcdefghijk') }],
    ['/youtube/durations', { ids: ['abcdefghijk'], extra: true }],
  ]) assert.equal(parseYouTubeRequest(path, body), null);
  assert.throws(() => parseYouTubeRequest('/youtube/search', { query: 'History', preferences: { invalid: true } }), { message: 'INVALID_PREFERENCES' });
});

test('validated operations preserve query, preferences, cancellation and response shapes', async () => {
  const signal = new AbortController().signal, preferences = defaultPreferences();
  const calls = [], result = { videos: [], requests: 1 };
  const youtube = {
    configured: async () => true,
    search: async (...args) => { calls.push(args); return result; },
    durations: async ids => ids.map(video_id => ({ video_id, duration_seconds: 120 })),
  };
  assert.deepEqual(await executeYouTubeRequest(parseYouTubeRequest('/youtube/status', {}), youtube, signal), { configured: true });
  const query = ' History of navigation ';
  assert.equal(await executeYouTubeRequest(parseYouTubeRequest('/youtube/search', { query, preferences }), youtube, signal), result);
  assert.deepEqual(calls[0], [query, preferences, signal]);
  assert.deepEqual(await executeYouTubeRequest(parseYouTubeRequest('/youtube/durations', { ids: ['abcdefghijk'] }), youtube, signal),
    { videos: [{ video_id: 'abcdefghijk', duration_seconds: 120 }] });
  assert.ok(parseYouTubeRequest('/youtube/search', { query: 'x'.repeat(300) }));
  assert.ok(parseYouTubeRequest('/youtube/durations', { ids: Array(50).fill('abcdefghijk') }));
});
