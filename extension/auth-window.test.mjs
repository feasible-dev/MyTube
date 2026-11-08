import test from 'node:test';
import assert from 'node:assert/strict';
import { watchAuthorization, validateAuthorizationUrl, authorizationWindowBounds } from './auth-window.mjs';
import { startConnector, EXTENSION_ID } from '../connector/server.mjs';
const url = 'https://auth.openai.com/api/accounts/authorize?response_type=code&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('login uses one bounded centered popup and removes only that window after callback', async () => {
  let polls = 0; const opened = [], removed = [];
  await watchAuthorization({ display: { availWidth: 1920, availHeight: 1040, availLeft: -1920, availTop: 0 }, requestId: 'test', signal: new AbortController().signal, pause: async () => {}, api: { windows: {
    create: async options => { opened.push(options); return { id: 42 }; }, get: async id => { assert.equal(id, 42); }, remove: async id => removed.push(id),
  } }, fetchImpl: async (_url, init) => { assert.equal(init.method, 'POST'); assert.equal(init.body, '{}'); assert.equal(init.headers['Content-Type'], 'application/json'); assert.equal(init.headers['X-MyTube-Request'], 'test'); return json({ authorization_url: ++polls <= 2 ? url : null }); } });
  assert.equal(opened.length, 1); assert.equal(opened[0].type, 'popup'); assert.equal(opened[0].width, 600); assert.equal(opened[0].height, 936);
  assert.equal(opened[0].left, -1260); assert.equal(opened[0].top, 52);
  assert.deepEqual(authorizationWindowBounds({ availWidth: 1536, availHeight: 824 }), { width: 600, height: 741, left: 468, top: 42 });
  assert.deepEqual(authorizationWindowBounds({ availWidth: 3840, availHeight: 2160 }), { width: 600, height: 960, left: 1620, top: 600 });
  assert.deepEqual(authorizationWindowBounds({ availWidth: 640, availHeight: 720 }), { width: 600, height: 648, left: 20, top: 36 });
  assert.deepEqual(authorizationWindowBounds(undefined), { width: 600, height: 960 });
  assert.deepEqual(removed, [42]);
});
test('popup cancellation, creation races and hostile authorization URLs fail safely', async () => {
  for (const bad of [url.replace('auth.openai.com', 'evil.example'), url + '&id_token_hint=secret', url.replace('127.0.0.1', 'example.com'), 'javascript:alert(1)']) assert.throws(() => validateAuthorizationUrl(bad));
  const controller = new AbortController(); const removed = [];
  await watchAuthorization({ requestId: 'test', signal: controller.signal, pause: async () => {}, api: { windows: {
    create: async () => { controller.abort(); return { id: 43 }; }, remove: async id => removed.push(id),
  } }, fetchImpl: async () => json({ authorization_url: url }) });
  assert.deepEqual(removed, [43]);
  await assert.rejects(watchAuthorization({ requestId: 'test', signal: new AbortController().signal, pause: async () => {}, api: { windows: {
    create: async () => ({ id: 44 }), get: async () => { throw Error('Closed'); }, remove: async () => {},
  } }, fetchImpl: async () => json({ authorization_url: url }) }), { code: 'CANCELLED' });
});

test('watcher stays available for automatic reconnection and closes only its owned popups', async () => {
  for (const withNullPoll of [true, false]) {
    const controller = new AbortController(), opened = [], removed = [], stages = [];
    const second = url + '&state=second-attempt';
    const values = withNullPoll ? [url, null, second, null, null] : [url, second, null, null];
    let polls = 0;
    await watchAuthorization({ requestId: 'test', signal: controller.signal, keepWatching: true,
      onStatus: stage => stages.push(stage), pause: async () => {}, api: { windows: {
        create: async options => { opened.push(options.url); return { id: opened.length }; },
        get: async () => {}, remove: async id => removed.push(id),
      } }, fetchImpl: async () => {
        const value = values[polls++];
        if (polls === values.length) controller.abort();
        return json({ authorization_url: value });
      } });
    assert.deepEqual(opened, [url, second]); assert.deepEqual(removed, [1, 2]);
    assert.equal(stages.filter(stage => stage === 'authorizing').length, 2);
  }
});

test('live loopback polling uses POST under extension-style Origin semantics and closes the popup', async () => {
  const id = '12345678-1234-4123-8123-123456789abc';
  const headers = { Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', 'X-MyTube-Request': id };
  let ready, received, release; const started = new Promise(resolve => { ready = resolve; });
  const callback = new Promise(resolve => { received = resolve; });
  const done = new Promise(resolve => { release = resolve; });
  const server = await startConnector({ port: 0, signOut: async () => {}, planner: async (_text, _signal, show) => {
    show(url); ready(); await callback; show(null); await done; return {};
  } });
  const removed = [];
  try {
    const pending = fetch(`http://127.0.0.1:${server.port}/plan`, { method: 'POST', headers, body: '{"intention":"synthetic"}' });
    await started;
    await watchAuthorization({ requestId: id, signal: new AbortController().signal, pause: async () => {}, api: { windows: {
      create: async () => { received(); return { id: 52 }; }, get: async () => {}, remove: async id => removed.push(id),
    } }, fetchImpl: async (target, init) => {
      const endpoint = new URL(target); endpoint.port = server.port;
      // Model privileged GET without Origin; POST retains the browser origin.
      return fetch(endpoint, { ...init, headers: { ...init.headers, ...(init.method === 'POST' ? { Origin: headers.Origin } : {}) } });
    } });
    assert.deepEqual(removed, [52]); release(); await (await pending).text();
  } finally { received(); release(); await server.close(); }
});

test('rejected or outdated connector responses do not claim that the connector is offline', async () => {
  for (const [status, code] of [[403, 'CONNECTOR_ACCESS_DENIED'], [404, 'CONNECTOR_UPDATE_REQUIRED'], [500, 'CONNECTOR_PROTOCOL_ERROR']]) {
    await assert.rejects(watchAuthorization({ requestId: 'test', signal: new AbortController().signal,
      api: { windows: { create: () => assert.fail('No window on failure') } },
      fetchImpl: async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
    }), { code });
  }
});
