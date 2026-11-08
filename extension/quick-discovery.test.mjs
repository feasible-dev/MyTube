import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverQuickly, quickSearchQuery } from './quick-discovery.mjs';
import { defaultPreferences } from './preferences.mjs';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const row = { video_id: 'abcdefghijk', title: 'Azores history', channel: 'Test channel', published_at: '2026-11-01', duration_seconds: 1800 };

test('a Google refusal stops a pending AI plan promptly and keeps cached results when available', { timeout: 1500 }, async () => {
  for (const cached of [[], [row]]) {
    let planSignal;
    const running = discoverQuickly({ intention: 'Azores history', cached,
      getToken: async () => 'TOKEN_CANARY_123456789', fetchImpl: async (url, init) => {
        if (new URL(url).hostname === '127.0.0.1') {
          planSignal = init.signal;
          return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
        }
        return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 429);
      } });
    if (cached.length) {
      const result = await running;
      assert.equal(result.warning, 'QUOTA_EXCEEDED'); assert.equal(result.provisional_source, 'cache'); assert.equal(result.complete, true);
    } else await assert.rejects(running, { code: 'QUOTA_EXCEEDED' });
    assert.equal(planSignal.aborted, true);
  }
});
test('quick videos arrive while the AI plan is still pending and survive a planner failure', async () => {
  let finishPlan; const pending = new Promise(resolve => { finishPlan = resolve; }); const updates = [];
  const running = discoverQuickly({ intention: 'Je voudrais quelque chose sur les Açores', preferences: defaultPreferences(),
    getToken: async () => 'TOKEN_CANARY_123456789', onProgress: result => updates.push(result),
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') return pending;
      if (u.pathname.endsWith('/search')) return json({ items: [{ id: { videoId: row.video_id } }] });
      return json({ items: [{ id: row.video_id, snippet: { title: row.title, channelTitle: row.channel, publishedAt: row.published_at,
        description: '', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT30M' }, statistics: {} }] });
    } });
  try {
    for (let i = 0; i < 30 && !updates.length; i++) await new Promise(setImmediate);
    assert.equal(updates[0].provisional_source, 'youtube'); assert.equal(updates[0].videos[0].title, row.title);
    assert.equal(updates[0].complete, false);
  } finally { finishPlan(json({ error: 'CHATGPT_LIMIT_REACHED' }, 400)); }
  const result = await running;
  assert.equal(result.fallback, true); assert.equal(result.warning, 'CHATGPT_LIMIT_REACHED'); assert.equal(result.videos.length, 1);
});
test('matching cache displays synchronously and survives a provider failure', async () => {
  for (const cached of [[row]]) {
    const updates = [];
    const running = discoverQuickly({ intention: 'Azores history', cached, alternatives: [row], preferences: defaultPreferences(),
      getToken: async () => 'TOKEN_CANARY_123456789', onProgress: r => updates.push(r),
      fetchImpl: async url => new URL(url).hostname === '127.0.0.1' ? json({ error: 'CHATGPT_UNAVAILABLE' }, 400)
        : json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403) });
    assert.equal(updates.length, cached.length ? 1 : 0);
    const result = await running; assert.equal(result.provisional_source, cached.length ? 'cache' : 'interests');
    assert.equal(result.fallback, true);
  }
});
test('quick query keeps exclusions, declines lossy truncation and cancellation suppresses updates', async () => {
  assert.equal(quickSearchQuery('Je voudrais quelque chose sur les Açores, sans croisières'), 'Açores, sans croisières');
  assert.equal(quickSearchQuery('Long description '.repeat(60)), null);
  const c = new AbortController(); c.abort();
  await assert.rejects(discoverQuickly({ intention: 'Azores', signal: c.signal, getToken: () => assert.fail('No authorization'),
    cached: [row], onProgress: () => assert.fail('No stale update'), fetchImpl: () => assert.fail('No network') }), { code: 'CANCELLED' });
});

test('a hanging quick authorization is bounded and does not inject unrelated interests', async () => {
  await assert.rejects(discoverQuickly({ intention: 'Azores history', preferences: defaultPreferences(), alternatives: [row], quickTimeoutMs: 10,
    getQuickToken: () => new Promise(() => {}), getToken: () => assert.fail('No interactive login'),
    fetchImpl: async () => json({ error: 'CHATGPT_UNAVAILABLE' }, 400) }), { code: 'CHATGPT_UNAVAILABLE' });
});

test('Mayas quick search rejects unrelated films before publishing, including when planning fails', async () => {
  const intention = "J'AIMERAIS SAVOIR PLEIN DE CHOSES SUR LES MAYAS ET PLEIN DE CHOSES APPARENTÉES.";
  assert.equal(quickSearchQuery(intention), 'MAYAS');
  const unrelated = { ...row, title: 'Thugs Corner a Rickshaw Driver', description: 'An action movie' };
  const updates = [];
  await assert.rejects(discoverQuickly({ intention, cached: [unrelated], alternatives: [unrelated],
    onProgress: r => updates.push(r), getToken: async () => 'TOKEN_CANARY_123456789',
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') return json({ error: 'CHATGPT_UNAVAILABLE' }, 400);
      if (u.pathname.endsWith('/search')) {
        assert.equal(u.searchParams.get('q'), 'MAYAS');
        return json({ items: [{ id: { videoId: row.video_id } }] });
      }
      return json({ items: [{ id: row.video_id, snippet: { title: unrelated.title, description: unrelated.description,
        channelTitle: 'Maya videos', publishedAt: row.published_at, liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT30M' }, statistics: {} }] });
    } }), { code: 'CHATGPT_UNAVAILABLE' });
  assert.deepEqual(updates, []);
});

test('enriched results replace provisional tiles without late quick-search updates', async () => {
  let finishPlan; const pending = new Promise(resolve => { finishPlan = resolve; }); const updates = [];
  const plan = { direct_subjects: ['Azores'], queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream,
    query: stream === 'direct' ? 'Azores history' : `${stream} ocean history`, why: 'Different historical connections' })) };
  const running = discoverQuickly({ intention: 'Azores', cached: [row], preferences: defaultPreferences(), onProgress: r => updates.push(r),
    getToken: async () => 'TOKEN_CANARY_123456789', getQuickToken: () => new Promise(() => {}),
    fetchImpl: async url => {
      const u = new URL(url); if (u.hostname === '127.0.0.1') return pending;
      return json({ items: u.pathname.endsWith('/search') ? [{ id: { videoId: 'lmnopqrstuv' } }] : [{ id: 'lmnopqrstuv',
        snippet: { title: 'Azores history documentary', channelTitle: 'Test channel', description: '', publishedAt: '2026-11-01', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT30M' }, statistics: {} }] });
    } });
  assert.equal(updates[0].provisional_source, 'cache'); finishPlan(json(plan));
  const result = await running;
  assert.ok(result.streams); assert.equal(result.provisional, undefined);
  assert.equal(result.videos[0].video_id, 'lmnopqrstuv'); assert.equal(updates.at(-1).complete, true);
});
