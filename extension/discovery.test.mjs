import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverVideos, requestDiscoveryPlan, validateDiscoveryPlan, allocateDiscoveryPools } from './discovery.mjs';
import { matchesDirectSubject } from './direct-relevance.mjs';
const plan = () => ({ queries: ['direct', 'adjacent', 'wildcard'].map((stream, i) => ({
  stream, query: ['physics university lectures', 'mathematical foundations seminar', 'history of scientific instruments'][i], why: 'A synthetic connection for testing only',
})) });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const id = 'abcdefghijk';

test('invalid plans are corrected once with the unchanged intention and a reviewable adjustment', async () => {
  let planners = 0, searches = 0;
  const result = await discoverVideos({ intention: 'Original intention', getToken: async () => 'TOKEN_CANARY_12345678',
    fetchImpl: async (url, options) => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') {
        const body = JSON.parse(options.body); assert.equal(body.intention, 'Original intention');
        if (++planners === 1) return json({ error: 'OFF_TOPIC_SEARCH_PLAN' }, 400);
        assert.equal(body.recovery, 'OFF_TOPIC_SEARCH_PLAN'); return json(plan());
      }
      searches++; return json({ items: [] });
    } });
  assert.equal(planners, 2); assert.equal(searches, 3);
  assert.equal(result.inference_requests, 2); assert.equal(result.adjustments[0].reason, 'OFF_TOPIC_SEARCH_PLAN');
});
test('zero results trigger one broader plan; all first and revised searches stay inspectable', async () => {
  let planners = 0, searches = 0;
  const result = await discoverVideos({ intention: 'Original intention', getToken: async () => 'TOKEN_CANARY_12345678',
    fetchImpl: async (url, options) => {
      if (new URL(url).hostname === '127.0.0.1') {
        if (++planners === 1) return json(expandedPlan());
        assert.equal(JSON.parse(options.body).recovery, 'NO_RESULTS');
        return json({ queries: expandedPlan().queries.map(q => ({ ...q, query: q.query + ' broader' })) });
      }
      searches++; return json({ items: [] });
    } });
  assert.equal(planners, 2); assert.equal(searches, 24);
  assert.equal(result.adjustments[0].previous_queries.length, 12);
  assert.equal(result.streams.direct.searches.length, 8);
});
test('recovery never loops or retries quota, refusal, transport or cancellation failures', async () => {
  for (const code of ['OFF_TOPIC_SEARCH_PLAN', 'CHATGPT_LIMIT_REACHED', 'CHATGPT_REFUSED', 'CHATGPT_UNAVAILABLE', 'CANCELLED']) {
    let calls = 0;
    await assert.rejects(discoverVideos({ intention: 'Synthetic request', getToken: () => assert.fail('No Google auth'),
      fetchImpl: async () => { calls++; return json({ error: code }, 400); } }), { code });
    assert.equal(calls, code === 'OFF_TOPIC_SEARCH_PLAN' ? 2 : 1);
  }
});

test('planning failures retain their safe category instead of all asking for sign-in', async () => {
  for (const code of ['CHATGPT_SIGN_IN_REQUIRED', 'CHATGPT_LIMIT_REACHED', 'CHATGPT_UNAVAILABLE', 'INVALID_SEARCH_PLAN', 'CHATGPT_RESPONSE_INCOMPLETE', 'INVALID_PLAN_SUBJECTS', 'OFF_TOPIC_SEARCH_PLAN', 'REPEATED_SEARCH_QUERIES']) {
    await assert.rejects(requestDiscoveryPlan('Synthetic viewing request', undefined, async () => json({ error: code }, 400)), { code });
  }
  await assert.rejects(requestDiscoveryPlan('Synthetic viewing request', undefined, async () => json({ error: 'PRIVATE_PROVIDER_CANARY' }, 400)), { code: 'CHATGPT_FAILED' });
});
const expandedPlan = () => ({ queries: plan().queries.flatMap(q => [1, 2, 3, 4].map(n => ({ ...q, query: `${q.query} ${n}` }))) });
const ids = (prefix, n = 12) => Array.from({ length: n }, (_, i) => prefix + String(i).padStart(10, '0'));
const metadata = ids => ({ items: ids.map(id => ({ id, snippet: { title: 'Physics synthetic lecture', channelTitle: 'Example University', description: '',
  publishedAt: '2025-01-01T00:00:00Z', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT50M' }, statistics: {} })) });

test('DIRECT keeps bilingual subject matches and rejects unrelated AI commentary before display', async () => {
  const subjects = ['New France', 'Nouvelle France'];
  const unwanted = { title: "Jon Stewart Unpacks AI's Dubious Promise", description: 'A discussion of artificial intelligence and socialism.' };
  assert.equal(matchesDirectSubject(unwanted, 'New France history', subjects), false);
  assert.equal(matchesDirectSubject({ title: 'La colonisation de la Nouvelle-France' }, 'New France history', subjects), true);
  assert.equal(matchesDirectSubject({ title: 'Colonial societies', description: 'An introduction to New France.' }, 'New France history', subjects), true);
  assert.equal(matchesDirectSubject({ title: 'Modern France', channel: 'New France TV' }, 'New France history', subjects), false);
  assert.equal(matchesDirectSubject({ title: 'Modern politics', description: 'x'.repeat(1600) + ' New France' }, 'New France history', subjects), false);
  const p = plan(); p.direct_subjects = subjects; p.queries[0].query = 'New France history';
  const updates = [];
  const result = await discoverVideos({ intention: 'Nouvelle-France', getToken: async () => 'TEST_TOKEN_123456789', onProgress: value => updates.push(value),
    fetchImpl: async url => {
      const u = new URL(url); if (u.hostname === '127.0.0.1') return json(p);
      if (u.pathname.endsWith('/search')) return json({ items: ids('n', 2).map(videoId => ({ id: { videoId } })) });
      const body = metadata(ids('n', 2));
      Object.assign(body.items[0].snippet, unwanted);
      body.items[1].snippet.title = 'La Nouvelle-France et sa colonisation'; return json(body);
    } });
  assert.equal(result.streams.direct.videos.length, 1);
  assert.equal(result.streams.direct.videos[0].video_id, ids('n', 2)[1]);
  assert.equal(result.streams.direct.searches[0].off_topic_filtered, 1);
  assert.ok(updates.every(value => value.streams.direct.videos.every(v => v.video_id !== ids('n', 2)[0])));
  const drifted = structuredClone(p); drifted.queries[0].query = 'artificial intelligence socialism';
  assert.throws(() => validateDiscoveryPlan(drifted), { code: 'OFF_TOPIC_SEARCH_PLAN' });
});

test('overlapping pools are shared fairly without inventing direction provenance', () => {
  const shared = ids('s', 36).map(video_id => ({ video_id }));
  const pools = { direct: shared, adjacent: shared, wildcard: shared };
  const allocated = allocateDiscoveryPools(pools);
  assert.deepEqual(Object.values(allocated).map(a => a.length), [12, 12, 12]);
  assert.equal(new Set(Object.values(allocated).flat().map(v => v.video_id)).size, 36);
  const scarce = allocateDiscoveryPools({ direct: shared, adjacent: [], wildcard: [shared[0]] });
  assert.equal(scarce.wildcard[0].video_id, shared[0].video_id);
});

test('directions start concurrently, publish partial results, and explore every angle even when full', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const searches = [], updates = []; let plans = 0;
  const pending = discoverVideos({ intention: 'synthetic', getToken: async () => 'TEST_TOKEN_123456789', onProgress: value => updates.push(value),
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') { plans++; return json(expandedPlan()); }
      if (u.pathname.endsWith('/videos')) return json(metadata(u.searchParams.get('id').split(',')));
      const query = u.searchParams.get('q'); searches.push(query);
      if (query === expandedPlan().queries[8].query) { await held; return json({ items: [] }); }
      const prefix = query.startsWith('physics') ? 'd' : query.startsWith('mathematical') ? 'a' : 'w';
      return json({ items: ids(prefix).map(videoId => ({ id: { videoId } })) });
    } });
  try {
    for (let i = 0; i < 30 && !updates.length; i++) await new Promise(setImmediate);
    assert.equal(searches.length, 3, 'All directions start before the slow response');
    assert.ok(updates.some(r => r.videos.length && !r.complete));
    assert.ok(updates[0].timing_ms.first_results !== null);
  } finally { release(); }
  const result = await pending;
  assert.equal(plans, 1); assert.equal(searches.length, 12); assert.equal(result.requests, 23);
  assert.deepEqual(Object.values(result.streams).map(s => s.videos.length), [12, 12, 12]);
  assert.ok(Object.values(result.streams).every(s => s.searches.length === 4));
  assert.ok(result.streams.wildcard.videos.every(v => v.discovery_query === expandedPlan().queries[9].query));
  assert.equal(result.complete, true);
});

test('underfilled searches stop after twelve queries and at most twenty-four Google calls', async () => {
  let calls = 0;
  const result = await discoverVideos({ intention: 'synthetic', getToken: async () => 'TEST_TOKEN_123456789', fetchImpl: async url => {
    const u = new URL(url); if (u.hostname === '127.0.0.1') return json(expandedPlan());
    calls++;
    return u.pathname.endsWith('/search') ? json({ items: [{ id: { videoId: id } }] }) : json(metadata([id]));
  } });
  assert.equal(calls, 24); assert.equal(result.requests, 24); assert.equal(result.videos.length, 1);
  assert.ok(Object.values(result.streams).every(s => s.searches.length === 4));
});

test('cancelling after partial results prevents further angle searches', async () => {
  const controller = new AbortController(); let searches = 0, updates = 0;
  await assert.rejects(discoverVideos({ intention: 'synthetic', signal: controller.signal, getToken: async () => 'TEST_TOKEN_123456789',
    onProgress: () => { updates++; controller.abort(); }, fetchImpl: async url => {
      const u = new URL(url); if (u.hostname === '127.0.0.1') return json(expandedPlan());
      if (u.pathname.endsWith('/search')) { searches++; return json({ items: [{ id: { videoId: id } }] }); }
      return json(metadata([id]));
    } }), { code: 'CANCELLED' });
  assert.equal(searches, 3); assert.equal(updates, 1);
});
test('one local plan precedes three bounded Google searches and global duplicate removal', async () => {
  const calls = [], stages = []; let tokens = 0;
  const intention = 'Please find serious physics lectures, avoiding hype. '.repeat(20);
  const result = await discoverVideos({ intention, onStage: stage => stages.push(stage), getToken: async () => { tokens++; return 'GOOGLE_CANARY_12345678'; },
    fetchImpl: async (url, options) => {
      calls.push(url); const target = new URL(url);
      if (target.hostname === '127.0.0.1') {
        assert.equal(calls.length, 1); assert.equal(options.headers.Authorization, undefined);
        assert.equal(JSON.parse(options.body).intention, intention.trim()); return json(plan());
      }
      assert.equal(target.origin, 'https://www.googleapis.com');
      assert.equal(options.headers.Authorization, 'Bearer GOOGLE_CANARY_12345678');
      assert.ok(!url.includes(intention));
      if (target.pathname.endsWith('/search')) return json({ items: [{ id: { videoId: id } }] });
      return json({ items: [{ id, snippet: { title: 'Physics lecture', channelTitle: 'Example University', description: '',
        publishedAt: '2025-01-01T00:00:00Z', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT50M' }, statistics: {} }] });
    } });
  assert.equal(calls.length, 7); assert.equal(result.requests, 6); assert.equal(tokens, 1);
  assert.equal(result.videos.length, 1); assert.equal(result.streams.direct.videos.length, 1);
  assert.equal(result.streams.adjacent.videos.length, 0); assert.equal(result.streams.wildcard.videos.length, 0);
  assert.deepEqual(stages, ['planning', 'youtube']);
});
test('malformed plans and connector failures never trigger Google authorization or raw error output', async () => {
  for (const value of [{}, { queries: [] }, { queries: [plan().queries[0], plan().queries[0], plan().queries[2]] }]) assert.throws(() => validateDiscoveryPlan(value));
  for (const response of [json({}), json({ error: 'PRIVATE_CANARY' }, 400)]) {
    await assert.rejects(discoverVideos({ intention: 'physics', getToken: () => assert.fail('No Google auth'), fetchImpl: async () => response }),
      error => !String(error).includes('PRIVATE_CANARY'));
  }
});
test('cancelled intentions, oversized responses and untrusted query URLs fail closed', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestDiscoveryPlan('physics', controller.signal, () => assert.fail('No request')), { code: 'CANCELLED' });
  await assert.rejects(requestDiscoveryPlan('physics', undefined, async () => new Response(' '.repeat(32769), { headers: { 'content-type': 'application/json' } })), { code: 'INVALID_SEARCH_PLAN' });
  const value = plan(); value.queries[0].query = 'https://evil.example/'; assert.throws(() => validateDiscoveryPlan(value));
});


test('busy connector is retried automatically with the same request and no duplicate job', async () => {
  let calls = 0; const waiting = [], bodies = [];
  const value = { queries: ['direct', 'adjacent', 'wildcard'].map((stream, i) => ({ stream, query: ['physics lectures', 'mathematics lectures', 'history lectures'][i], why: 'Connection' })) };
  const result = await requestDiscoveryPlan('Physics', undefined, async (_url, init) => {
    bodies.push(init.body);
    return new Response(JSON.stringify(++calls === 1 ? { error: 'CONNECTOR_BUSY' } : value), { status: calls === 1 ? 409 : 200, headers: { 'content-type': 'application/json' } });
  }, undefined, undefined, undefined, undefined, undefined, busy => waiting.push(busy));
  assert.equal(calls, 2); assert.equal(bodies[0], bodies[1]); assert.deepEqual(waiting, [true, false]); assert.equal(result.queries.length, 3);
});

test('cancelling while connector is busy prevents any retry', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(requestDiscoveryPlan('Physics', controller.signal, async () => { calls++; return new Response('{}', { status: 409, headers: { 'content-type': 'application/json' } }); }, undefined, undefined, undefined, undefined, undefined, () => controller.abort()), { code: 'CANCELLED' });
  assert.equal(calls, 1);
});
