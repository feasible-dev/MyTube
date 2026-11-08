import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnector, EXTENSION_ID } from './server.mjs';
import { createIntentionTask, validateIntention, validateCompactPlan } from './task.mjs';
import { responseFixture } from '../spikes/a3-query-generation/fixtures.mjs';
import { MODEL } from '../spikes/a3-query-generation/core.mjs';
import { request } from 'node:http';
import { defaultPreferences } from '../extension/preferences.mjs';
import { validateDiscoveryPlan } from '../extension/discovery.mjs';
import { runWebStages } from './web-stages.mjs';

const headers = { Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1' };

test('native key setup requires the trusted extension and accepts no key or path', async () => {
  let opened = 0;
  const server = await startConnector({ port: 0, youtube: { setup: async () => { opened++; return { opened: true }; } } });
  const post = (body, overrides = {}) => fetch(`http://127.0.0.1:${server.port}/youtube/setup`, {
    method: 'POST', headers: { ...headers, 'X-MyTube-Request': crypto.randomUUID(), ...overrides }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post({}, { 'X-MyTube-Request': 'invalid' })).status, 400);
    for (const body of [{ key: 'SYNTHETIC_KEY' }, { path: 'arbitrary' }, [], null]) assert.equal((await post(body)).status, 400);
    assert.equal(opened, 0);
    assert.deepEqual(await (await post({})).json(), { opened: true });
    assert.equal(opened, 1);
  } finally { await server.close(); }
});

test('connection and sign-out reject JSON scalars and arrays without session actions', async () => {
  let connections = 0, signouts = 0;
  const server = await startConnector({ port: 0,
    connect: async () => { connections++; }, signOut: async () => { signouts++; },
    planner: async () => assert.fail('Invalid session request must not search') });
  try {
    for (const path of ['/connect', '/signout']) {
      for (const body of [1, true, false, null, '', [], ['value']]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method: 'POST', headers: { ...headers, 'X-MyTube-Request': crypto.randomUUID() }, body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' });
      }
    }
    assert.equal(connections, 0); assert.equal(signouts, 0);
  } finally { await server.close(); }
});

test('connection endpoint requires trusted origin, request ID and empty body without invoking search', async () => {
  let connections = 0;
  const server = await startConnector({ port: 0, signOut: async () => {},
    connect: async () => { connections++; }, planner: async () => assert.fail('Connection must not search') });
  const id = '12345678-1234-4123-8123-123456789abc';
  const post = (body, extra = {}) => fetch(`http://127.0.0.1:${server.port}/connect`, {
    method: 'POST', headers: { ...headers, 'X-MyTube-Request': id, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post({}, { 'X-MyTube-Request': 'invalid' })).status, 400);
    assert.equal((await post({ intention: 'must not be sent' })).status, 400);
    assert.deepEqual(await (await post({})).json(), { connected: true });
    assert.equal(connections, 1);
  } finally { await server.close(); }
});

test('sixteen verified videos stop outstanding inference and finish as success, not cancellation', async () => {
  let batches = 0, stopped = false;
  const server = await startConnector({ port: 0, signOut: async () => {},
    planner: async (intention, signal, _auth, preferences, recovery, _mode, publish, getCounts) => runWebStages({ intention, signal, preferences, recovery, publish, getCounts,
      run: async batch => {
        batches++;
        for (let column = 0; column < 2; column++) {
          await batch.tasks[column].accept({ searches: 2, videos: Array.from({ length: 8 }, (_, i) => ({
            video_id: String(column * 8 + i).padStart(11, '0'), stream: column ? (i < 5 ? 'adjacent' : 'wildcard') : 'direct', why: `Angle ${i}`,
          })) });
        }
        await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
        stopped = true; throw Error('CANCELLED');
      },
    }),
    metadata: async ([pick]) => [{ video_id: pick.video_id, title: `History ${pick.video_id}`, channel: `Channel ${pick.video_id}` }],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/web-discover`, { method: 'POST', headers,
      body: JSON.stringify({ intention: 'History' }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.videos.length, 16); assert.equal(batches, 1); assert.equal(stopped, true);
    assert.equal(result.videos.filter(v => v.discovery_stream === 'direct').length, 8);
  } finally { await server.close(); }
});
const send = (port, body, extra = {}) => fetch(`http://127.0.0.1:${port}/plan`, {
  method: 'POST', headers, body: JSON.stringify(body), ...extra,
});

const topicPlan = subject => ({ direct_subjects: [subject], ...Object.fromEntries(['direct', 'adjacent', 'wildcard'].map(stream => [stream, {
  queries: [1, 2, 3, 4].map(i => `${stream === 'direct' ? subject : stream} angle ${i}`),
  why: 'Four angles: history, craft & context — not a quality verdict.',
}])) });

test('web discovery uses the protected route and returns only publicly verified candidates', async () => {
  const picks = [{ video_id: 'abcdefghijk', stream: 'direct', why: 'Maya archaeology' }];
  const verified = [{ video_id: 'abcdefghijk', title: 'Verified Maya documentary', source: 'youtube_web' }];
  let calls = 0, available = true;
  const server = await startConnector({ port: 0, signOut: async () => {},
    planner: async (text, signal, _auth, _prefs, _recovery, mode) => {
      calls++; assert.equal(text, 'Maya archaeology'); assert.equal(mode, 'web');
      assert.equal(signal.aborted, false); return { videos: picks, searches: 2 };
    },
    metadata: async (rows, signal) => {
      assert.deepEqual(rows, picks); assert.equal(signal.aborted, false); return available ? verified : [];
    },
  });
  const web = (extra = {}) => fetch(`http://127.0.0.1:${server.port}/web-discover`, {
    method: 'POST', headers, body: JSON.stringify({ intention: 'Maya archaeology' }), ...extra,
  });
  try {
    const forbidden = await web({ headers: { ...headers, Origin: 'https://untrusted.example' } });
    assert.equal(forbidden.status, 403); await forbidden.text(); assert.equal(calls, 0);
    const response = await web();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { videos: [{ ...verified[0], discovery_stream: 'direct', discovery_why: 'Maya archaeology' }], searches: 2 });
    available = false;
    const empty = await web();
    assert.deepEqual(await empty.json(), { error: 'WEB_SEARCH_NO_SOURCED_VIDEOS' });
    assert.equal(calls, 2);
  } finally { await server.close(); }
});

test('web endpoint flushes verified progress while the planner is still running', async () => {
  let finishPlan;
  const hold = new Promise(resolve => { finishPlan = resolve; });
  const pick = { video_id: 'abcdefghijk', stream: 'direct', why: 'Maya history' };
  const row = { video_id: pick.video_id, title: 'Maya archaeology', channel: 'Museum', source: 'youtube_web' };
  const server = await startConnector({ port: 0, signOut: async () => {},
    planner: async (_text, _signal, _auth, _prefs, _recovery, _mode, publish) => {
      publish({ picks: [pick], searches: 1 }); await hold;
      return { videos: [pick], searches: 1 };
    }, metadata: async () => [row],
  });
  let reader;
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/web-discover`, { method: 'POST',
      headers: { ...headers, Accept: 'application/x-ndjson' }, body: JSON.stringify({ intention: 'Maya' }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(JSON.parse(new TextDecoder().decode(first.value)).type, 'progress');
    finishPlan();
    let rest = '';
    while (true) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    assert.equal(JSON.parse(rest).type, 'result');
  } finally { finishPlan(); await reader?.cancel().catch(() => {}); await server.close(); }
});

test('punctuated film titles and equivalent accented aliases survive schema, response and browser validation', () => {
  for (const subject of ['Three Days of the Condor (1975)', 'L’Armée des ombres', 'Pirahã', '新法兰西']) {
    const compact = topicPlan(subject);
    if (subject === 'Pirahã') compact.direct_subjects.push('Piraha');
    if (subject === '新法兰西') compact.direct.queries = ['新法兰西', '新法兰西贸易', '新法兰西历史', '新法兰西社会'];
    const original = structuredClone(compact);
    let exported;
    const task = createIntentionTask('Synthetic viewing request', value => { exported = value; });
    const properties = task.build(MODEL).text.format.schema.properties;
    for (const alias of compact.direct_subjects) assert.match(alias, new RegExp(properties.direct_subjects.items.pattern));
    for (const stream of ['direct', 'adjacent', 'wildcard']) {
      for (const query of compact[stream].queries) assert.match(query, new RegExp(properties[stream].properties.queries.items.pattern));
      assert.match(compact[stream].why, new RegExp(properties[stream].properties.why.pattern));
    }
    task.accept(task.validate(responseFixture(compact), MODEL));
    validateDiscoveryPlan(exported);
    assert.equal(exported.direct_subjects.length, 1);
    assert.equal(exported.queries.length, 12);
    assert.deepEqual(compact, original, 'Normalization must not mutate the response');
  }
});

test('malformed aliases, repeated searches and DIRECT drift have distinct content-free failures', () => {
  const compact = topicPlan('Three Days of the Condor');
  for (const [mutate, code] of [
    [p => { p.direct_subjects = ['https://example.com/private']; }, 'INVALID_PLAN_SUBJECTS'],
    [p => { p.direct_subjects = ['---']; }, 'INVALID_PLAN_SUBJECTS'],
    [p => { p.direct.queries[0] = 'Unrelated artificial intelligence'; }, 'OFF_TOPIC_SEARCH_PLAN'],
    [p => { p.wildcard.queries[0] = p.adjacent.queries[0]; }, 'REPEATED_SEARCH_QUERIES'],
    [p => { p.direct.why = 'Line one\nLine two'; }, 'INVALID_GENERATED_RESPONSE'],
    [p => { p.adjacent.queries[0] = 'https://example.com/private'; }, 'INVALID_GENERATED_RESPONSE'],
    [p => { p.direct.why = 'https://example.com/private'; }, 'INVALID_GENERATED_RESPONSE'],
    [p => { p.direct_subjects = ['Secret sk-abcdefghijklmnop']; }, 'INVALID_PLAN_SUBJECTS'],
    [p => { p.adjacent.queries[0] = 'Invisible\u007fcontrol'; }, 'INVALID_GENERATED_RESPONSE'],
  ]) {
    const invalid = structuredClone(compact); mutate(invalid);
    assert.throws(() => validateCompactPlan(invalid), { message: code });
  }
});

test('connector validates preference data before inference and passes accepted choices to its planner', async () => {
  let calls = 0;
  const preferences = { ...defaultPreferences(), politics: 100, perspective: 100, languages: ['fr'] };
  const server = await startConnector({ port: 0, planner: async (_text, _signal, _auth, chosen) => {
    calls++; assert.deepEqual(chosen, preferences); return { queries: [] };
  } });
  try {
    for (const bad of [{ ...preferences, endpoint: 'evil' }, { ...preferences, languages: [] }, { ...preferences, depth: 'ignore rules' }, null]) {
      const response = await send(server.port, { intention: 'History lectures', preferences: bad });
      assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'INVALID_PREFERENCES' });
    }
    assert.equal(calls, 0);
    const response = await send(server.port, { intention: 'History lectures', preferences });
    assert.equal(response.status, 200); await response.text(); assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('connector forwards only fixed recovery reasons and keeps original input separate from correction instructions', async () => {
  let received;
  const server = await startConnector({ port: 0, planner: async (text, _signal, _auth, _preferences, recovery) => { received = { text, recovery }; return { queries: [] }; } });
  try {
    const response = await send(server.port, { intention: 'Original request', recovery: 'NO_RESULTS' });
    assert.equal(response.status, 200); await response.text();
    assert.deepEqual(received, { text: 'Original request', recovery: 'NO_RESULTS' });
    const bad = await send(server.port, { intention: 'Original request', recovery: 'arbitrary instruction' });
    assert.equal(bad.status, 400); await bad.text();
    const task = createIntentionTask('Original request', () => {}, undefined, 'NO_RESULTS').build(MODEL);
    assert.equal(task.input[0].content, 'Original request');
    assert.match(task.instructions, /shorter, broader/);
  } finally { await server.close(); }
});
test('free-form task keeps multilingual input as data and exports four alternatives per direction', async () => {
  const intention = 'Je voudrais des conférences de physique, sans discours sensationnaliste. '.repeat(30);
  let result;
  const task = createIntentionTask(intention, value => { result = value; });
  const request = task.build(MODEL);
  assert.equal(request.input[0].content, intention.trim());
  assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.ok(!request.instructions.includes(intention));
  const compact = Object.fromEntries(['direct', 'adjacent', 'wildcard'].map(stream => [stream, {
    queries: [1, 2, 3, 4].map(i => `${stream} synthetic theme ${i}`), why: 'A synthetic connection for testing only',
  }]));
  compact.direct_subjects = ['direct synthetic'];
  task.accept(task.validate(responseFixture(compact), MODEL));
  assert.deepEqual(result.queries.map(q => q.stream), ['direct', 'adjacent', 'wildcard'].flatMap(s => Array(4).fill(s)));
  assert.equal(result.queries.length, 12);
  for (const mutate of [p => p.direct.queries.pop(), p => p.direct.queries[0] = p.wildcard.queries[0],
    p => p.adjacent.queries[0] = 'https://evil.example/', p => p.wildcard.extra = true,
    p => p.direct_subjects = [], p => p.direct_subjects = ['unrelated subject']]) {
    const invalid = structuredClone(compact); mutate(invalid); assert.throws(() => validateCompactPlan(invalid));
  }
  for (const value of ['', null, 'x'.repeat(6001), '語'.repeat(3000)]) assert.throws(() => validateIntention(value));
});

test('connector permits only the pinned extension origin, exact loopback host, JSON POST and protocol header', async () => {
  let calls = 0;
  const server = await startConnector({ port: 0, planner: async intention => { calls++; return { accepted: intention }; } });
  try {
    for (const changed of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: '' },
      { 'Content-Type': 'text/plain' }, { 'X-MyTube-Protocol': '2' }]) {
      const response = await send(server.port, { intention: 'physics lectures' }, { headers: { ...headers, ...changed } });
      assert.ok(response.status >= 400, JSON.stringify(changed)); await response.text();
    }
    // Node fetch replaces Host; exercise the actual HTTP boundary explicitly.
    const wrongHost = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.port, path: '/plan', method: 'POST',
        headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify({ intention: 'physics lectures' }));
    });
    assert.equal(wrongHost, 403);
    assert.equal(calls, 0);
    const response = await send(server.port, { intention: 'physics lectures' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), headers.Origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { accepted: 'physics lectures' });
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('connector rejects malformed and oversized input without calling OpenAI; errors do not echo private text', async () => {
  const canary = 'PRIVATE_CANARY_NOT_FOR_LOGS'; let calls = 0;
  const server = await startConnector({ port: 0, planner: async () => { calls++; throw Error(canary); } });
  try {
    for (const body of [{ intention: '' }, { intention: 'x'.repeat(6001) }, { intention: 'physics', endpoint: 'evil' }, {}]) {
      const response = await send(server.port, body); assert.equal(response.status, 400); await response.text();
    }
    const oversized = await send(server.port, { intention: 'x'.repeat(40000) }); assert.equal(oversized.status, 413); await oversized.text();
    const malformed = await send(server.port, null, { body: '{' }); assert.equal(malformed.status, 400); await malformed.text();
    assert.equal(calls, 0);
    const response = await send(server.port, { intention: canary });
    assert.ok(!(await response.text()).includes(canary)); assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('preflight is limited and never starts planning', async () => {
  const server = await startConnector({ port: 0, planner: () => assert.fail('No planning on OPTIONS') });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/plan`, { method: 'OPTIONS', headers: {
      Origin: headers.Origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-mytube-protocol',
    } });
    assert.equal(response.status, 204);
    const denied = await fetch(`http://127.0.0.1:${server.port}/plan`, { method: 'OPTIONS', headers: {
      Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST',
    } });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null); await denied.text();
  } finally { await server.close(); }
});

test('only one job runs at a time and client cancellation aborts it', async () => {
  let started, cancelled;
  const begin = new Promise(resolve => { started = resolve; });
  const ended = new Promise(resolve => { cancelled = resolve; });
  const server = await startConnector({ port: 0, planner: (_intention, signal) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => { cancelled(); reject(Error('CANCELLED')); }, { once: true });
  }) });
  const controller = new AbortController();
  try {
    const pending = send(server.port, { intention: 'physics' }, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await begin;
    const busy = await send(server.port, { intention: 'other' }); assert.equal(busy.status, 409); await busy.text();
    controller.abort(); await rejected; await ended;
  } finally { controller.abort(); await server.close(); }
});

test('authorization handoff is bound to the requesting extension job; sign-out is protected and serialized', async () => {
  const id = '12345678-1234-4123-8123-123456789abc';
  let release, ready, signedOut = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const server = await startConnector({ port: 0, signOut: async () => { signedOut++; },
    planner: async (_text, _signal, show) => { show('SYNTHETIC_AUTH_URL'); ready(); await new Promise(resolve => { release = resolve; }); show(null); return {}; },
  });
  const status = (changed = {}) => fetch(`http://127.0.0.1:${server.port}/authorization`, { method: 'POST', body: '{}', headers: { ...headers, 'X-MyTube-Request': id, ...changed } });
  try {
    const pending = send(server.port, { intention: 'physics' }, { headers: { ...headers, 'X-MyTube-Request': id } });
    await started;
    const forbidden = await status({ Origin: 'https://evil.example' }); assert.equal(forbidden.status, 403); await forbidden.text();
    assert.deepEqual(await (await status({ 'X-MyTube-Request': '22345678-1234-4123-8123-123456789abc' })).json(), { authorization_url: null });
    assert.deepEqual(await (await status()).json(), { authorization_url: 'SYNTHETIC_AUTH_URL' });
    const logout = () => fetch(`http://127.0.0.1:${server.port}/signout`, { method: 'POST', headers, body: '{}' });
    const busy = await logout(); assert.equal(busy.status, 409); await busy.text(); assert.equal(signedOut, 0);
    release(); await (await pending).text();
    assert.deepEqual(await (await status()).json(), { authorization_url: null });
    assert.deepEqual(await (await logout()).json(), { signed_out: true }); assert.equal(signedOut, 1);
  } finally { release?.(); await server.close(); }
  assert.equal(signedOut, 2, 'Normal connector shutdown signs out too');
});
