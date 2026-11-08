import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { runFlow } from '../a1-openai-login/flow.mjs';
import { ISSUER, RESOURCE, DISCOVERY, SCOPES, consumeStream } from '../a1-openai-login/protocol.mjs';
import { chatgptRequest, validateChatgptResponse } from './chatgpt-task.mjs';
import { generatedFixture, responseFixture } from './fixtures.mjs';

const reference = JSON.parse(await readFile(new URL('../b1-controlled-discovery/plan.json', import.meta.url), 'utf8'));
const model = 'test-account-model';
const generated = () => generatedFixture(reference);
const completed = value => ({ type: 'response.completed', response: { ...responseFixture(value ?? generated()), model } });
const credentials = { access: 'SYNTHETICACCESSCANARYLONG', refresh: 'SYNTHETICREFRESHCANARYLONG' };
const signing = await generateKeyPair('RS256');
const jwks = { keys: [{ ...await exportJWK(signing.publicKey), kid: 'a3-test', alg: 'RS256', use: 'sig' }] };
const clientId = 'oaiapp_a3test';
const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
  token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/test-jwks`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`, id_token_signing_alg_values_supported: ['RS256'] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function sse(events, missingType = false) {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset += 37));
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  if (missingType) response.headers.delete('Content-Type');
  return response;
}

async function simulate({ events, missingType = false, revokeStatus = 200, scope = SCOPES,
  cancelBeforeInference = false, exportFails = false } = {}) {
  const calls = [], saved = [];
  let nonce, accepted;
  const controller = new AbortController();
  const report = await runFlow({ registration: { version: 1,
    host_id: 'urn:uuid:12345678-1234-4123-8123-123456789abc', client_id: null, identity_hash: null },
  signal: controller.signal,
  saveRegistration: async record => { saved.push(structuredClone(record)); },
  authorize: async attempt => {
    nonce = attempt.nonce;
    return { clientId, code: 'SYNTHETICCODECANARY', redirectUri: 'http://127.0.0.1:54321/auth/callback' };
  },
  inferenceTask: { build: chatgptRequest, validate: validateChatgptResponse, accept: value => {
    assert.equal(calls.at(-1), discovery.revocation_endpoint);
    if (exportFails) throw new Error(credentials.access);
    accepted = value;
  } },
  fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    if (url === DISCOVERY) return json(discovery);
    if (url === discovery.token_endpoint) {
      const id_token = await new SignJWT({ iss: ISSUER, aud: clientId, sub: 'synthetic-person', nonce,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })
        .setProtectedHeader({ alg: 'RS256', kid: 'a3-test' }).sign(signing.privateKey);
      return json({ access_token: credentials.access, refresh_token: credentials.refresh,
        id_token, token_type: 'Bearer', expires_in: 3600, scope });
    }
    if (url === discovery.revocation_endpoint) {
      assert.equal(init.body.get('token'), credentials.refresh);
      assert.equal(init.signal.aborted, false);
      return new Response(null, { status: revokeStatus });
    }
    if (init.signal.aborted) throw new Error(credentials.access);
    if (url === discovery.jwks_uri) return json(jwks);
    if (url === `${RESOURCE}/models`) {
      if (cancelBeforeInference) controller.abort();
      return json({ models: [{ visibility: 'list', slug: model }] });
    }
    if (url === `${RESOURCE}/responses`) {
      assert.equal(init.headers.Authorization, `Bearer ${credentials.access}`);
      assert.deepEqual(JSON.parse(init.body), chatgptRequest(model));
      assert.ok(!init.body.includes(credentials.access));
      return sse(events ?? [completed()], missingType);
    }
    assert.fail('Unexpected destination');
  } });
  const publicText = JSON.stringify({ report, saved, accepted });
  for (const secret of [...Object.values(credentials), 'SYNTHETICCODECANARY', 'synthetic-person']) {
    assert.ok(!publicText.includes(secret));
  }
  return { report, calls, accepted };
}

test('ChatGPT task uses catalog model, streaming, input array, and omits unsupported token-limit fields', () => {
  const body = chatgptRequest(model);
  assert.equal(body.model, model); assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.ok(Array.isArray(body.input)); assert.equal(body.text.format.strict, true);
  for (const field of ['max_output_tokens', 'temperature', 'background', 'metadata', 'previous_response_id', 'tools']) {
    assert.equal(Object.hasOwn(body, field), false);
  }
});

test('OAuth query flow validates identity, generates twelve queries once, then revokes before release', async () => {
  const { report, calls, accepted } = await simulate();
  assert.equal(report.status, 'TECHNICAL_PASS'); assert.equal(report.identity_verified, true);
  assert.equal(report.plan_permission_granted, true); assert.equal(report.session_revocation, 'ACKNOWLEDGED');
  assert.equal(report.inference_requests, 1);
  assert.equal(calls.filter(url => url === `${RESOURCE}/responses`).length, 1);
  assert.deepEqual(accepted.generated, generated()); assert.equal(report.verdict, null);
});

test('missing stream header still requires complete SSE and generated-query validation', async () => {
  const { report, accepted } = await simulate({ missingType: true });
  assert.equal(report.status, 'TECHNICAL_PASS'); assert.equal(report.inference_content_type, 'missing');
  assert.deepEqual(accepted.generated, generated());
});

test('duplicate model queries stop the task and still revoke; no generated result escapes', async () => {
  const g = generated(); g.streams.adjacent.queries[0].query = g.streams.direct.queries[0].query;
  const { report, accepted } = await simulate({ events: [completed(g)] });
  assert.equal(report.failure_code, 'DUPLICATE_QUERIES'); assert.equal(accepted, undefined);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});

test('credential reflection in otherwise valid generated prose is rejected before export', async () => {
  const g = generated(); g.underlying_interests[0] = credentials.access;
  const { report, accepted } = await simulate({ events: [completed(g)] });
  assert.equal(report.failure_code, 'CREDENTIAL_ECHO_REJECTED'); assert.equal(accepted, undefined);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED');
});

test('missing plan permission stops before inference and still revokes', async () => {
  const { report, accepted } = await simulate({ scope: 'openid' });
  assert.equal(report.failure_code, 'PLAN_PERMISSION_MISSING'); assert.equal(report.inference_requests, 0);
  assert.equal(report.session_revocation, 'ACKNOWLEDGED'); assert.equal(accepted, undefined);
});

test('failed terminal events and interrupted streams never release a result', async () => {
  for (const events of [[{ type: 'response.failed', response: { error: { message: credentials.access } } }],
    [{ type: 'response.incomplete' }], [{ type: 'response.output_text.delta', delta: '{}' }]]) {
    const { report, accepted } = await simulate({ events });
    assert.equal(report.status, 'BLOCKED'); assert.equal(accepted, undefined);
    assert.equal(report.session_revocation, 'ACKNOWLEDGED'); assert.equal(report.inference_requests, 1);
  }
});

test('unconfirmed cleanup withholds generated data; only cleanup may retry', async () => {
  const { report, accepted, calls } = await simulate({ revokeStatus: 500 });
  assert.equal(report.status, 'CLEANUP_REQUIRED'); assert.equal(accepted, undefined);
  assert.equal(calls.filter(url => url === discovery.revocation_endpoint).length, 2);
  assert.equal(calls.filter(url => url === `${RESOURCE}/responses`).length, 1);
});

test('cancellation preserves cleanup and local export failures remain sanitized', async () => {
  const cancelled = await simulate({ cancelBeforeInference: true });
  assert.equal(cancelled.report.session_revocation, 'ACKNOWLEDGED'); assert.equal(cancelled.accepted, undefined);
  const exported = await simulate({ exportFails: true });
  assert.equal(exported.report.failure_code, 'RESULT_EXPORT_FAILED');
  assert.equal(exported.report.session_revocation, 'ACKNOWLEDGED');
});

test('validator rejects tools, refusals and model substitution without exposing provider strings', async () => {
  for (const [mutate, expected] of [
    [r => { r.model = 'unexpected'; }, 'UNEXPECTED_MODEL'],
    [r => { r.output.push({ type: 'function_call', arguments: credentials.access }); }, 'UNEXPECTED_OUTPUT_TYPE'],
    [r => { r.output[1].content = [{ type: 'refusal', refusal: credentials.access }]; }, 'MODEL_REFUSAL'],
  ]) {
    const event = completed(); mutate(event.response);
    await assert.rejects(consumeStream(sse([event]), r => validateChatgptResponse(r, model)),
      error => error.message === expected && !String(error).includes(credentials.access));
  }
});
