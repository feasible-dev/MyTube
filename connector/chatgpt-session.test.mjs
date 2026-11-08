import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createChatGPTSession } from './chatgpt-session.mjs';
import { ISSUER, RESOURCE, DISCOVERY, SCOPES, Failure } from '../spikes/a1-openai-login/protocol.mjs';
const signing = await generateKeyPair('RS256');
const jwks = { keys: [{ ...await exportJWK(signing.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }] };
const clientId = 'oaiapp_session_test';
const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
  token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/test-jwks`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`, id_token_signing_alg_values_supported: ['RS256'] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
test('connection preflight reuses verified login and does not perform inference', async () => {
  const f = await fixture();
  await f.session.connect();
  await f.session.connect();
  assert.equal(f.counts().auth, 1); assert.equal(f.counts().inference, 0);
  await f.session.plan(f.task);
  assert.equal(f.counts().auth, 1); assert.equal(f.counts().inference, 1);
  await f.session.signOut();
});
async function fixture({ badNonce = false, revokeFails = false, echo = false, rejectInference = false, inferenceStatuses = [] } = {}) {
  let nonce, now = Date.now(), auth = 0, inference = 0, revoked = 0, accepted = 0, catalogs = 0;
  const saved = [];
  const session = createChatGPTSession({
    registration: { client_id: null, host_id: 'urn:uuid:12345678-1234-4123-8123-123456789abc', identity_hash: null },
    saveRegistration: async r => saved.push(structuredClone(r)), now: () => now,
    authorize: async attempt => { nonce = attempt.nonce; auth++; return { clientId, code: 'CODE_CANARY', redirectUri: 'http://127.0.0.1:54321/auth/callback' }; },
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (url === DISCOVERY) return json(discovery);
      if (url === discovery.token_endpoint) {
        const id_token = await new SignJWT({ iss: ISSUER, aud: clientId, sub: 'person', nonce: badNonce ? 'wrong' : nonce,
          iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(signing.privateKey);
        return json({ access_token: 'ACCESS_CANARY_12345', refresh_token: 'REFRESH_CANARY_12345', id_token, token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
      }
      if (url === discovery.jwks_uri) return json(jwks);
      if (url === discovery.revocation_endpoint) { revoked++; assert.equal(init.body.get('token'), 'REFRESH_CANARY_12345'); assert.equal(init.signal.aborted, false); return new Response(null, { status: revokeFails ? 400 : 200 }); }
      assert.equal(init.headers.Authorization, 'Bearer ACCESS_CANARY_12345');
      if (url === `${RESOURCE}/models`) { catalogs++; return json({ models: [{ slug: 'test-model', visibility: 'list' }] }); }
      assert.equal(url, `${RESOURCE}/responses`); inference++;
      if (rejectInference || inferenceStatuses[inference - 1]) return json({ error: 'ACCESS_CANARY_12345' }, inferenceStatuses[inference - 1] || 401);
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', text: echo ? 'ACCESS_CANARY_12345' : 'safe' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const task = { build: model => ({ model, store: false, stream: true, input: [{ role: 'user', content: 'synthetic' }] }), validate: value => value, accept: () => { accepted++; } };
  return { session, task, advance: ms => { now += ms; }, counts: () => ({ auth, inference, revoked, accepted }), catalogs: () => catalogs, saved };
}
test('two searches reuse one validated memory session; explicit sign-out revokes and next search signs in again', async () => {
  const f = await fixture();
  await f.session.plan(f.task); await f.session.plan(f.task);
  assert.deepEqual(f.counts(), { auth: 1, inference: 2, revoked: 0, accepted: 2 });
  assert.equal(f.catalogs(), 1, 'Model selection is reused within the validated session');
  assert.ok(!JSON.stringify(f.saved).includes('CANARY'));
  await f.session.signOut(); assert.equal(f.counts().revoked, 1);
  await f.session.plan(f.task); assert.equal(f.counts().auth, 2);
  assert.equal(f.catalogs(), 2, 'A new session refreshes the model catalog');
  await f.session.signOut();
});
test('expiry reconnects before another inference; concurrent work is rejected', async () => {
  const f = await fixture();
  const pending = f.session.plan(f.task);
  await assert.rejects(f.session.plan(f.task), { message: 'CONNECTOR_BUSY' });
  await assert.rejects(f.session.signOut(), { message: 'CONNECTOR_BUSY' });
  await pending; f.advance(3600000); await f.session.plan(f.task);
  assert.deepEqual(f.counts(), { auth: 2, inference: 2, revoked: 1, accepted: 2 });
  await f.session.signOut();
});

test('cancelling a verified search preserves login for the next search', async () => {
  const f = await fixture(), controller = new AbortController(), validate = f.task.validate;
  f.task.validate = value => { controller.abort(); return validate(value); };
  await assert.rejects(f.session.plan(f.task, controller.signal), { message: 'CANCELLED' });
  assert.equal(f.counts().revoked, 0);
  f.task.validate = validate; await f.session.plan(f.task);
  assert.deepEqual(f.counts(), { auth: 1, inference: 2, revoked: 0, accepted: 1 });
  await f.session.signOut();
});
test('identity failure and credential reflection discard credentials without leaking them', async () => {
  for (const options of [{ badNonce: true }, { echo: true }]) {
    const f = await fixture(options);
    await assert.rejects(f.session.plan(f.task), { message: 'CHATGPT_FAILED' });
    assert.equal(f.counts().accepted, 0); assert.equal(f.counts().revoked, 1);
    if (options.badNonce) assert.equal(f.counts().inference, 0);
    await f.session.signOut(); assert.equal(f.counts().revoked, 1);
  }
});

test('rejected cached credentials trigger one automatic reauthorization and resume the same task', async () => {
  const f = await fixture({ inferenceStatuses: [0, 401, 0] });
  await f.session.plan(f.task);
  await f.session.plan(f.task);
  assert.deepEqual(f.counts(), { auth: 2, inference: 3, revoked: 1, accepted: 2 });
  await f.session.signOut();
});

test('repeated authentication rejection stops after one reconnect without looping', async () => {
  const f = await fixture({ rejectInference: true });
  await assert.rejects(f.session.plan(f.task), { message: 'CHATGPT_SIGN_IN_REQUIRED' });
  assert.deepEqual(f.counts(), { auth: 2, inference: 2, revoked: 2, accepted: 0 });
});

test('invalid generated output reports a plan error without discarding a verified login', async () => {
  const f = await fixture(), validate = f.task.validate;
  f.task.validate = () => { throw new Failure('INVALID_GENERATED_RESPONSE'); };
  await assert.rejects(f.session.plan(f.task), { message: 'INVALID_SEARCH_PLAN' });
  assert.deepEqual(f.counts(), { auth: 1, inference: 1, revoked: 0, accepted: 0 });
  f.task.validate = validate; await f.session.plan(f.task);
  assert.deepEqual(f.counts(), { auth: 1, inference: 2, revoked: 0, accepted: 1 });
  await f.session.signOut();
});

test('specific plan failures preserve the verified session and never automatically repeat inference', async () => {
  const f = await fixture(), validate = f.task.validate;
  for (const code of ['INVALID_PLAN_SUBJECTS', 'OFF_TOPIC_SEARCH_PLAN', 'REPEATED_SEARCH_QUERIES']) {
    f.task.validate = () => { throw new Failure(code); };
    await assert.rejects(f.session.plan(f.task), { message: code });
  }
  assert.deepEqual(f.counts(), { auth: 1, inference: 3, revoked: 0, accepted: 0 });
  f.task.validate = validate; await f.session.plan(f.task);
  assert.deepEqual(f.counts(), { auth: 1, inference: 4, revoked: 0, accepted: 1 });
  await f.session.signOut();
});

test('rate limits, access restrictions and temporary failures preserve session and never retry inference automatically', async () => {
  for (const [status, code] of [[400, 'CHATGPT_REQUEST_REJECTED'], [403, 'CHATGPT_ACCESS_DENIED'], [429, 'CHATGPT_LIMIT_REACHED'], [503, 'CHATGPT_UNAVAILABLE']]) {
    const f = await fixture({ inferenceStatuses: [status, 0] });
    await assert.rejects(f.session.plan(f.task), { message: code });
    assert.deepEqual(f.counts(), { auth: 1, inference: 1, revoked: 0, accepted: 0 });
    await f.session.plan(f.task);
    assert.deepEqual(f.counts(), { auth: 1, inference: 2, revoked: 0, accepted: 1 });
    await f.session.signOut();
  }
});
test('unconfirmed revocation clears local session and reports cleanup required; pre-cancel sends nothing', async () => {
  const f = await fixture({ revokeFails: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.session.plan(f.task, controller.signal), { message: 'CANCELLED' });
  assert.equal(f.counts().auth, 0);
  await f.session.plan(f.task);
  await assert.rejects(f.session.signOut(), { message: 'CLEANUP_REQUIRED' });
  await f.session.signOut(); assert.equal(f.counts().revoked, 1);
});


test('four platform tasks share one login and never run more than two workers', async () => {
  const f = await fixture(), started = [], accepted = [];
  const release = [], held = [0, 1, 2, 3].map(i => new Promise(resolve => { release[i] = resolve; }));
  const tasks = held.map((gate, i) => ({ ...f.task, validate: async value => { started.push(i); await gate; return value; }, accept: () => accepted.push(i) }));
  const pending = f.session.plan({ tasks, accept() {} });
  const waitForWorkers = async count => {
    const deadline = Date.now() + 2000;
    // Identity verification runs on the crypto worker pool; event-loop turns
    // are not a meaningful timeout when this suite runs alongside other tests.
    while (started.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  };
  try {
    await waitForWorkers(2);
    assert.deepEqual(started, [0, 1]);
    await assert.rejects(f.session.signOut(), { message: 'CONNECTOR_BUSY' });
    await assert.rejects(f.session.plan(f.task), { message: 'CONNECTOR_BUSY' });
    release[1]();
    await waitForWorkers(3);
    assert.deepEqual(started, [0, 1, 2]); assert.deepEqual(accepted, [1]);
  } finally { release.forEach(fn => fn()); }
  await pending;
  assert.equal(f.counts().auth, 1); assert.equal(f.counts().inference, 4);
  assert.equal(accepted.length, 4); await f.session.signOut();
});

test('bad output in one column does not cancel other columns or invalidate login', async () => {
  const f = await fixture();
  await f.session.plan({ tasks: [{ ...f.task, validate() { throw new Failure('INVALID_GENERATED_RESPONSE'); } }, f.task, f.task], accept() {} });
  assert.deepEqual(f.counts(), { auth: 1, inference: 3, revoked: 0, accepted: 2 });
  await f.session.signOut();
});

test('credential echo in a batch rejects siblings before accepting any result or clearing tokens', async () => {
  const f = await fixture({ echo: true });
  await assert.rejects(f.session.plan({ tasks: [f.task, f.task, f.task], accept() { assert.fail('batch accepted'); } }), { message: 'CHATGPT_FAILED' });
  assert.equal(f.counts().accepted, 0); assert.equal(f.counts().revoked, 1);
  assert.equal(f.counts().inference, 2);
});

test('batch cancellation joins running tasks and preserves the verified session', async () => {
  const f = await fixture(), controller = new AbortController();
  const cancelling = { ...f.task, validate(value) { controller.abort(); return value; } };
  await assert.rejects(f.session.plan({ tasks: [cancelling, f.task, f.task], accept() {} }, controller.signal), { message: 'CANCELLED' });
  assert.equal(f.counts().accepted, 0); assert.equal(f.counts().revoked, 0);
  await f.session.plan(f.task); assert.equal(f.counts().auth, 1); await f.session.signOut();
});


test('a timed out column does not discard other results or revoke login', async () => {
  const f = await fixture();
  const slow = { ...f.task, timeoutMs: 30000, validate() { throw new DOMException('Timed out', 'TimeoutError'); } };
  await f.session.plan({ tasks: [slow, f.task, f.task], accept() {} });
  assert.deepEqual(f.counts(), { auth: 1, inference: 3, revoked: 0, accepted: 2 });
  await f.session.signOut();
});
