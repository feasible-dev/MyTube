import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { listenForCallback } from './callback.mjs';
import { runFlow } from './flow.mjs';
import {
  ISSUER, RESOURCE, DISCOVERY, SCOPES, INTENT, authorizationUrl, callbackResult,
  consumeStream, freshAttempt, inferenceBody, readJson, selectModel,
  validateDiscovery, validateTokenResponse, verifyIdentity, responseMediaType,
} from './protocol.mjs';

// These are ephemeral, synthetic keys and tokens, never production credentials.
const key = await generateKeyPair('RS256');
const otherKey = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(key.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const jwks = { keys: [jwk] };
const clientId = 'oaiapp_test';
const redirectUri = 'http://127.0.0.1:54321/auth/callback';
const registration = () => ({ version: 1, host_id: 'urn:uuid:12345678-1234-4123-8123-123456789abc', client_id: null, identity_hash: null });
const discovery = () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
  token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  id_token_signing_alg_values_supported: ['RS256'],
});
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const completed = (intent = INTENT) => ({ type: 'response.completed', response: {
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(intent) }] }],
} });
function sse(events, chunkSize = 7, separator = '\r\n\r\n') {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}${separator}`).join(''));
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(index, index += chunkSize));
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
async function idToken(nonce, overrides = {}, signingKey = key.privateKey) {
  return new SignJWT({ iss: ISSUER, aud: clientId, sub: 'synthetic-user', nonce,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
}
function tokens(id_token = 'synthetic-id-token') {
  return { access_token: 'SYNTHETIC_ACCESS_CANARY', refresh_token: 'SYNTHETIC_REFRESH_CANARY',
    id_token, token_type: 'Bearer', expires_in: 3600, scope: SCOPES };
}

test('authorization uses fresh independent state/nonce, S256 PKCE, and exact callback', () => {
  const first = freshAttempt(), second = freshAttempt();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.nonce, first.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(first.verifier.length, 43);
  const url = new URL(authorizationUrl(first, registration(), redirectUri));
  assert.equal(url.origin, ISSUER);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('agent_name_hint'), 'MyTube');
  assert.equal(url.searchParams.get('code_verifier'), null);
  assert.equal(url.searchParams.get('client_secret'), null);
  const returning = new URL(authorizationUrl(second, { ...registration(), client_id: clientId }, redirectUri));
  assert.equal(returning.searchParams.get('client_id'), clientId);
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
});

test('callback accepts issued client ID and rejects state/host/path/parameter attacks', async t => {
  const attempt = freshAttempt();
  const base = `/auth/callback?state=${attempt.state}&code=test-code&client_id=${clientId}`;
  const check = (url = base, host = '127.0.0.1:54321', method = 'GET', tx = attempt, saved) =>
    callbackResult(url, host, method, tx, redirectUri, saved);
  assert.deepEqual(check(), { code: 'test-code', clientId });
  assert.deepEqual(check(`/auth/callback?state=${attempt.state}&code=test-code`, undefined, undefined, undefined, clientId), { code: 'test-code', clientId });
  const cases = [
    ['wrong state', () => check(base.replace(attempt.state, 'forged')), /CALLBACK_STATE/],
    ['DNS rebinding Host', () => check(base, 'attacker.example:54321'), /CALLBACK_ORIGIN/],
    ['localhost substitution', () => check(base, 'localhost:54321'), /CALLBACK_ORIGIN/],
    ['wrong path', () => check(base.replace('/auth/callback', '/callback')), /CALLBACK_PATH/],
    ['absolute URL', () => check(`https://attacker.example${base}`), /CALLBACK_PATH/],
    ['duplicate state', () => check(`${base}&state=${attempt.state}`), /CALLBACK_DUPLICATE_PARAMETER/],
    ['duplicate code', () => check(`${base}&code=other`), /CALLBACK_DUPLICATE_PARAMETER/],
    ['POST', () => check(base, undefined, 'POST'), /CALLBACK_ORIGIN/],
    ['expired transaction', () => check(base, undefined, undefined, { ...attempt, expiresAt: 0 }), /CALLBACK_EXPIRED/],
    ['client substitution', () => check(base, undefined, undefined, undefined, 'oaiapp_other'), /CALLBACK_CLIENT_CHANGED/],
    ['missing issued client', () => check(`/auth/callback?state=${attempt.state}&code=test`), /CALLBACK_CLIENT_ID/],
    ['denial', () => check(`/auth/callback?state=${attempt.state}&error=access_denied`), /AUTHORIZATION_DENIED/],
    ['denial with wrong state', () => check('/auth/callback?state=forged&error=access_denied'), /CALLBACK_STATE/],
  ];
  for (const [name, action, error] of cases) await t.test(name, () => assert.throws(action, error));
});

test('OIDC metadata cannot redirect token or JWKS requests to another origin', () => {
  assert.equal(validateDiscovery(discovery()).issuer, ISSUER);
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
    assert.throws(() => validateDiscovery({ ...discovery(), [field]: 'https://attacker.example/collect' }));
  }
  for (const value of ['http://auth.openai.com/keys', 'https://auth.openai.com.attacker.example/keys',
    'https://user:password@auth.openai.com/keys', 'https://auth.openai.com/keys?redirect=other']) {
    assert.throws(() => validateDiscovery({ ...discovery(), jwks_uri: value }));
  }
});

test('real JWT verification rejects forged or invalid identity claims', async t => {
  const nonce = freshAttempt().nonce;
  const good = await idToken(nonce);
  const identityHash = await verifyIdentity(good, jwks, clientId, nonce);
  assert.match(identityHash, /^[a-f0-9]{64}$/);
  const cases = [
    ['issuer', { iss: 'https://attacker.example' }], ['audience', { aud: 'oaiapp_other' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }], ['nonce', { nonce: 'wrong' }],
    ['future issued time', { iat: Math.floor(Date.now() / 1000) + 600 }],
    ['future validity', { nbf: Math.floor(Date.now() / 1000) + 600 }],
    ['empty subject', { sub: '' }], ['missing subject', { sub: undefined }],
    ['missing expiry', { exp: undefined }], ['missing issued time', { iat: undefined }],
    ['multiple audiences without azp', { aud: [clientId, 'other'] }],
    ['wrong azp', { azp: 'oaiapp_other' }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => assert.rejects(verifyIdentity(await idToken(nonce, overrides), jwks, clientId, nonce), /IDENTITY_INVALID/));
  }
  await assert.rejects(verifyIdentity(await idToken(nonce, {}, otherKey.privateKey), jwks, clientId, nonce), /IDENTITY_INVALID/);
  await assert.rejects(verifyIdentity(await idToken(nonce, { sub: 'other-user' }), jwks, clientId, nonce, identityHash), /IDENTITY_INVALID/);
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${good.split('.')[1]}.`;
  await assert.rejects(verifyIdentity(unsigned, jwks, clientId, nonce), /IDENTITY_INVALID/);
  const hmac = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
  await assert.rejects(verifyIdentity(hmac, jwks, clientId, nonce), /IDENTITY_INVALID/);
});

test('tokens require actual granted permission, bearer type, renewable session and expiry', () => {
  validateTokenResponse(tokens());
  for (const changes of [{ scope: 'openid profile email' }, { token_type: 'Other' }, { expires_in: -1 },
    { expires_in: '3600' }, { access_token: 'secret\r\nX: injected' }, { refresh_token: undefined }]) {
    assert.throws(() => validateTokenResponse({ ...tokens(), ...changes }));
  }
});

test('model selection uses the account catalog and rejects unavailable/hidden models', () => {
  const catalog = { models: [{ slug: 'hidden', visibility: 'hide' }, { slug: 'test-model', visibility: 'list' }] };
  assert.equal(selectModel(catalog), 'test-model');
  assert.throws(() => selectModel(catalog, 'hidden'), /MODEL_UNAVAILABLE/);
  assert.throws(() => selectModel({ data: [{ id: 'test-model' }] }), /MODEL_CATALOG_INVALID/);
  assert.throws(() => selectModel({ models: [{ slug: 'bad\nslug', visibility: 'list' }] }), /MODEL_UNAVAILABLE/);
  assert.deepEqual(Object.keys(inferenceBody('test-model')).sort(), ['model', 'store', 'stream', 'instructions', 'input'].sort());
});

test('SSE handles split frames and UTF-8; completion and exact JSON schema are required', async () => {
  assert.equal(await consumeStream(sse([{ type: 'response.output_text.delta', delta: 'é' }, completed()], 1)), true);
  assert.equal(await consumeStream(sse([completed()], 5, '\n\n')), true);
  await assert.rejects(consumeStream(sse([{ type: 'response.output_text.delta', delta: '{}' }])), /STREAM_TRUNCATED/);
  for (const type of ['response.failed', 'response.incomplete', 'error']) {
    await assert.rejects(consumeStream(sse([{ type }])), /INFERENCE_FAILED/);
  }
  await assert.rejects(consumeStream(sse([completed({ ...INTENT, unexpected: 'secret' })])), /INTENT_SCHEMA_INVALID/);
  await assert.rejects(consumeStream(sse([completed({ ...INTENT, min_minutes: '20' })])), /INTENT_SCHEMA_INVALID/);
  await assert.rejects(consumeStream(jsonResponse(completed())), /STREAM_CONTENT_TYPE/);
  const oversized = new Response(`data: ${'x'.repeat(2 * 1024 * 1024)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(consumeStream(oversized), /STREAM_TOO_LARGE/);
  await assert.rejects(readJson(jsonResponse({ payload: 'x'.repeat(100) }), 20), /HTTP_BODY_TOO_LARGE/);
});
test('media-type diagnostics are allowlisted and rejected responses are cancelled unread', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'Content-Type': 'application/x-DO_NOT_LOG_THIS_SECRET' },
  });
  assert.equal(responseMediaType(response), 'other');
  await assert.rejects(consumeStream(response), /STREAM_CONTENT_TYPE/);
  assert.equal(cancelled, true);
  assert.equal(responseMediaType(new Response(null)), 'missing');
  const mixedCase = sse([completed()]);
  mixedCase.headers.set('Content-Type', 'Text/Event-Stream; charset=UTF-8');
  assert.equal(await consumeStream(mixedCase), true);
});
test('missing Content-Type requires a valid completed SSE response, not arbitrary bytes', async () => {
  const valid = sse([completed()]);
  valid.headers.delete('Content-Type');
  assert.equal(await consumeStream(valid), true);
  for (const body of ['<html>Not SSE</html>', JSON.stringify(completed()), 'data: <html>bad</html>\n\n']) {
    const invalid = new Response(new TextEncoder().encode(body));
    assert.equal(responseMediaType(invalid), 'missing');
    await assert.rejects(consumeStream(invalid), /STREAM_TRUNCATED|STREAM_EVENT_INVALID/);
  }
  const incomplete = sse([{ type: 'response.output_text.delta', delta: '{}' }]);
  incomplete.headers.delete('Content-Type');
  await assert.rejects(consumeStream(incomplete), /STREAM_TRUNCATED/);
});

function localGet(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: host ? { Host: host } : {} }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end();
  });
}
test('real loopback listener ignores forged callbacks, consumes once, and does not reflect secrets', async () => {
  const attempt = freshAttempt();
  const listener = await listenForCallback(attempt, null);
  try {
    assert.equal(new URL(listener.redirectUri).hostname, '127.0.0.1');
    const forged = await localGet(`${listener.redirectUri}?state=bad&code=CANARY&client_id=${clientId}`);
    assert.equal(forged.status, 400);
    assert.equal(forged.text.includes('CANARY'), false);
    const url = `${listener.redirectUri}?state=${attempt.state}&code=CANARY&client_id=${clientId}`;
    assert.equal((await localGet(url, 'attacker.example')).status, 400);
    const valid = await localGet(url);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers['cache-control'], 'no-store');
    assert.equal(valid.headers['referrer-policy'], 'no-referrer');
    assert.equal(valid.headers['access-control-allow-origin'], undefined);
    assert.equal(valid.text.includes('CANARY'), false);
    assert.equal((await listener.result).clientId, clientId);
    assert.equal((await localGet(url)).status, 409);
  } finally { await listener.close(); }
});
test('loopback timeout closes a pending authorization without accepting a callback', async () => {
  const listener = await listenForCallback({ ...freshAttempt(), expiresAt: Date.now() + 30 }, null);
  try { await assert.rejects(listener.result, /CALLBACK_TIMEOUT/); }
  finally { await listener.close(); }
});

async function simulate({ tokenChanges = {}, claimChanges = {}, failAt, revokeStatus = 200, events, cancelAfterTokens = false, malformedTokens = false, catalogPadding = 0, missingStreamType = false } = {}) {
  const calls = [], saved = [];
  let nonce;
  const controller = new AbortController();
  const report = await runFlow({
    registration: registration(), signal: controller.signal,
    saveRegistration: async record => { saved.push(structuredClone(record)); },
    authorize: async (attempt, makeUrl) => {
      nonce = attempt.nonce;
      const url = new URL(makeUrl(redirectUri));
      assert.equal(url.searchParams.get('state'), attempt.state);
      return { code: 'SYNTHETIC_CODE_CANARY', clientId, redirectUri };
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      if (url === failAt) throw new Error('DO_NOT_LOG_THIS_SECRET');
      if (url === DISCOVERY) return jsonResponse(discovery());
      if (url === discovery().token_endpoint) {
        assert.equal(init.body.get('client_id'), clientId);
        assert.equal(init.body.get('redirect_uri'), redirectUri);
        assert.equal(init.body.has('client_secret'), false);
        if (cancelAfterTokens) controller.abort();
        if (malformedTokens) return jsonResponse('malformed');
        return jsonResponse({ ...tokens(await idToken(nonce, claimChanges)), ...tokenChanges });
      }
      if (url === discovery().revocation_endpoint) {
        assert.equal(init.body.get('token_type_hint'), 'refresh_token');
        assert.equal(init.body.get('client_id'), clientId);
        assert.equal(init.signal.aborted, false); // cleanup survives Ctrl+C
        return new Response(null, { status: revokeStatus });
      }
      if (init.signal.aborted) throw new Error('Abort');
      if (url === discovery().jwks_uri) return jsonResponse(jwks);
      if (url === `${RESOURCE}/models`) return jsonResponse({ models: [{ slug: 'test-model', visibility: 'list', description: 'x'.repeat(catalogPadding) }] });
      if (url === `${RESOURCE}/responses`) {
        const body = JSON.parse(init.body);
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.ok(Array.isArray(body.input));
        const response = sse(events ?? [completed()]);
        if (missingStreamType) response.headers.delete('Content-Type');
        return response;
      }
      assert.fail('Unexpected HTTP destination');
    },
  });
  const publicData = JSON.stringify([report, saved]);
  for (const marker of ['SYNTHETIC_ACCESS_CANARY', 'SYNTHETIC_REFRESH_CANARY', 'SYNTHETIC_CODE_CANARY', 'DO_NOT_LOG_THIS_SECRET', 'synthetic-user']) {
    assert.equal(publicData.includes(marker), false);
  }
  return { report, calls };
}

test('offline full flow: validates identity, one inference, session cleanup, no false GO', async () => {
  const { report, calls } = await simulate();
  assert.equal(report.status, 'TECHNICAL_PASS');
  assert.equal(report.identity_verified, true);
  assert.equal(report.structured_response_validated, true);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
  assert.equal(report.verdict, null);
  assert.equal(report.billing_verified, false);
  assert.equal(report.expiration_observed, false);
  assert.equal(calls.filter(call => call.url === `${RESOURCE}/responses`).length, 1);
});
test('catalog above the old 512 KiB limit can complete one inference and cleanup', async () => {
  const { report, calls } = await simulate({ catalogPadding: 1024 * 1024 });
  assert.equal(report.status, 'TECHNICAL_PASS');
  assert.ok(report.model_catalog_received_bytes > 1024 * 1024);
  assert.equal(report.model_catalog_limit_bytes, 8 * 1024 * 1024);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
  assert.equal(calls.filter(call => call.url === `${RESOURCE}/responses`).length, 1);
});
test('live-regression fixture: large catalog and absent stream header still require full validation', async () => {
  const { report } = await simulate({ catalogPadding: 655729, missingStreamType: true });
  assert.equal(report.status, 'TECHNICAL_PASS');
  assert.equal(report.inference_http_status, 200);
  assert.equal(report.inference_content_type, 'missing');
  assert.equal(report.structured_response_validated, true);
  assert.equal(report.inference_requests, 1);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});
test('catalog exceeding 8 MiB still fails closed before inference and revokes', async () => {
  const { report } = await simulate({ catalogPadding: 8 * 1024 * 1024 });
  assert.equal(report.failed_stage, 'model_catalog');
  assert.equal(report.failure_code, 'HTTP_BODY_TOO_LARGE');
  assert.ok(report.model_catalog_received_bytes > report.model_catalog_limit_bytes);
  assert.equal(report.inference_requests, 0);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});
test('catalog allowance does not raise the default bound for authentication JSON', async () => {
  let bytes = 0;
  await assert.rejects(readJson(jsonResponse({ payload: 'x'.repeat(512 * 1024) }), undefined,
    count => { bytes = count; }), /HTTP_BODY_TOO_LARGE/);
  assert.ok(bytes > 512 * 1024);
});
test('missing plan permission stops before inference and still revokes', async () => {
  const { report } = await simulate({ tokenChanges: { scope: 'openid' } });
  assert.equal(report.failure_code, 'PLAN_PERMISSION_MISSING');
  assert.equal(report.inference_requests, 0);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});
test('bad ID-token nonce stops before catalog/inference and still revokes', async () => {
  const { report } = await simulate({ claimChanges: { nonce: 'wrong' } });
  assert.equal(report.failure_code, 'IDENTITY_INVALID');
  assert.equal(report.inference_requests, 0);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});
test('inference failure is never retried, and cleanup still runs', async () => {
  const { report, calls } = await simulate({ failAt: `${RESOURCE}/responses` });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.failure_code, 'NETWORK_OR_RUNTIME_ERROR');
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
  assert.equal(calls.filter(call => call.url === `${RESOURCE}/responses`).length, 1);
});
test('lost token response does not falsely claim no cleanup is needed', async () => {
  const { report } = await simulate({ failAt: discovery().token_endpoint });
  assert.equal(report.session_revocation, 'UNCONFIRMED');
  assert.equal(report.inference_requests, 0);
});
test('malformed token response remains a sanitized failure with cleanup unconfirmed', async () => {
  const { report } = await simulate({ malformedTokens: true });
  assert.equal(report.failure_code, 'TOKEN_RESPONSE_INVALID');
  assert.equal(report.session_revocation, 'UNCONFIRMED');
  assert.equal(report.inference_requests, 0);
});
test('incomplete SSE causes failure and cleanup', async () => {
  const { report } = await simulate({ events: [{ type: 'response.incomplete' }] });
  assert.equal(report.failure_code, 'INFERENCE_FAILED');
  assert.equal(report.structured_response_validated, false);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});
test('failed remote revocation cannot be reported as a clean technical pass', async () => {
  const { report, calls } = await simulate({ revokeStatus: 500 });
  assert.equal(report.status, 'CLEANUP_REQUIRED');
  assert.equal(report.session_revocation, 'UNCONFIRMED');
  assert.equal(report.verdict, null);
  assert.equal(calls.filter(call => call.url === discovery().revocation_endpoint).length, 2);
});
test('a non-retryable revocation error is not repeatedly sent', async () => {
  const { report, calls } = await simulate({ revokeStatus: 400 });
  assert.equal(report.session_revocation, 'UNCONFIRMED');
  assert.equal(calls.filter(call => call.url === discovery().revocation_endpoint).length, 1);
});
test('cancellation after token receipt still attempts revocation on a separate deadline', async () => {
  const { report } = await simulate({ cancelAfterTokens: true });
  assert.equal(report.inference_requests, 0);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});
