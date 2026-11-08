import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshHomeTopics } from './home-refresh.mjs';
import { defaultPreferences } from './preferences.mjs';
const topics = ['Navigation', 'Cinema'].map(label => ({ label, queries: [`${label} history`, `${label} craft`], subjects: [label], preferences: defaultPreferences() }));
test('home refresh bypasses ChatGPT, bounds Google calls, targets recent uploads and keeps subject filtering', async () => {
  const calls = [], batches = [];
  const result = await refreshHomeTopics({ topics, getToken: async () => 'TOKEN_CANARY_12345678', onBatch: batch => batches.push(batch),
    fetchImpl: async url => {
      const u = new URL(url); assert.equal(u.origin, 'https://www.googleapis.com'); calls.push(u);
      const items = u.pathname.endsWith('/search') ? [{ id: { videoId: 'aaaaaaaaaaa' } }] : [{ id: 'aaaaaaaaaaa',
        snippet: { title: 'Navigation history', channelTitle: 'Test channel', description: '', publishedAt: '2026-11-01', liveBroadcastContent: 'none' },
        contentDetails: { duration: 'PT30M' }, statistics: { viewCount: '100' } }];
      return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
    } });
  assert.equal(result.requests, 8); assert.equal(batches.length, 4);
  assert.equal(calls.filter(u => u.searchParams.has('publishedAfter')).length, 2);
  assert.ok(batches.filter(b => b.label === 'Cinema').every(b => b.videos.length === 0));
  assert.ok(batches.filter(b => b.label === 'Navigation').every(b => b.videos.length === 1));
});
test('home refresh stops before network on absent authorization, cancellation or invalid stored topics', async () => {
  const noFetch = () => assert.fail('No provider call');
  await assert.rejects(refreshHomeTopics({ topics, getToken: async () => { throw Error('No cached sign-in'); }, fetchImpl: noFetch }));
  const c = new AbortController(); c.abort();
  await assert.rejects(refreshHomeTopics({ topics, signal: c.signal, getToken: noFetch, fetchImpl: noFetch }), { code: 'CANCELLED' });
  await assert.rejects(refreshHomeTopics({ topics: [{ ...topics[0], queries: ['https://evil.example'] }], getToken: noFetch, fetchImpl: noFetch }), { code: 'INVALID_QUERY' });
});
