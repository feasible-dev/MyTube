import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { buildRequest, validateGenerated, validateKey, parseResponse, generateOnce, compareQueries,
  MODEL, ENDPOINT, LIMITS, INTENTION, STREAMS } from './core.mjs';
import { readOpenAIKey } from './key-input.mjs';
import { generatedFixture, responseFixture } from './fixtures.mjs';

const reference = JSON.parse(await readFile(new URL('../b1-controlled-discovery/plan.json', import.meta.url), 'utf8'));
const generated = () => generatedFixture(reference);
const envelope = () => responseFixture(generated());
const canary = 'sk-synthetic_test_canary_not_a_real_key_12345';
const response = body => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { headers: { 'content-type': 'application/json' } });
const terminal = () => {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, paused: false,
    setRawMode(v) { this.isRaw = v; }, setEncoding() {}, resume() {}, pause() { this.paused = true; } });
  const output = { isTTY: true, text: '', write(s) { this.text += s; } };
  return { input, output };
};

test('request fixes public intention, model, no storage, no tools and output budget', () => {
  const body = buildRequest();
  assert.equal(body.model, MODEL); assert.equal(body.store, false); assert.equal(body.stream, false);
  assert.deepEqual(body.tools, []); assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.text.format.strict, true); assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.input[0].content[0].text, INTENTION); assert.equal(INTENTION, reference.intention);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= LIMITS.max_request_bytes);
  assert.ok(!JSON.stringify(body).includes(canary));
});

test('one bounded POST keeps the key in the authorization header and returns only validated data and numeric usage', async () => {
  const ledger = []; let calls = 0;
  const result = await generateOnce(canary, ledger, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${canary}`);
    assert.ok(!options.body.includes(canary)); assert.deepEqual(JSON.parse(options.body), buildRequest());
    return response({ ...envelope(), id: 'private_provider_identifier', debug: 'discard me' });
  } });
  assert.equal(calls, 1); assert.deepEqual(result.generated, generated());
  assert.deepEqual(result.usage, { input_tokens: 80, output_tokens: 20, total_tokens: 100 });
  assert.ok(!JSON.stringify({ ledger, result }).includes(canary));
  assert.ok(!JSON.stringify(result).includes('private_provider_identifier'));
  await assert.rejects(generateOnce(canary, ledger), /REQUEST_BUDGET_EXCEEDED/);
});

test('strict output contract rejects extra fields, invalid types, bounds, controls, URLs and code-like content', () => {
  const mutations = [g => { g.endpoint = 'https://evil.invalid'; }, g => { g.streams.direct.extra = true; },
    g => { g.streams.wildcard.queries.pop(); }, g => { g.underlying_interests = []; },
    g => { g.streams.direct.queries[0].interest_index = '0'; },
    g => { g.streams.direct.queries[0].query = 'https://evil.invalid'; },
    g => { g.streams.direct.queries[0].why = 'Text with an escape\u001b[31m'; },
    g => { g.streams.direct.queries[0].query = 'NASA $(read secrets)'; },
    g => { g.streams.direct.connection = canary; },
    g => { g.streams.direct.objective = 'a'.repeat(301); },
    g => { g.streams.direct.queries[0].query = 'x'.repeat(151); }];
  for (const mutate of mutations) { const g = generated(); mutate(g); assert.throws(() => validateGenerated(g), /INVALID_GENERATED_SCHEMA/); }
  for (const value of [null, [], 4, {}, { ...generated(), streams: [] }]) assert.throws(() => validateGenerated(value), /INVALID_GENERATED_SCHEMA/);
});

test('cross-field checks reject canonical duplicate queries, interests, objectives and dangling interest references', () => {
  for (const [mutate, expected] of [
    [g => { g.streams.adjacent.queries[0].query = g.streams.direct.queries[0].query.toUpperCase().replaceAll(' ', '-'); }, 'DUPLICATE_QUERIES'],
    [g => { g.underlying_interests[1] = g.underlying_interests[0]; }, 'DUPLICATE_INTERESTS'],
    [g => { g.streams.wildcard.objective = g.streams.direct.objective; }, 'DUPLICATE_OBJECTIVES'],
    [g => { g.streams.direct.queries[0].interest_index = 5; }, 'INVALID_INTEREST_REFERENCE'],
  ]) { const g = generated(); mutate(g); assert.throws(() => validateGenerated(g), e => e.message === expected); }
});

test('completed response is required; refusal, tool calls, multiple messages and incomplete JSON fail closed', () => {
  for (const [mutate, expected] of [
    [r => { r.status = 'incomplete'; }, 'RESPONSE_NOT_COMPLETED'],
    [r => { r.incomplete_details = { reason: 'max_output_tokens' }; }, 'RESPONSE_NOT_COMPLETED'],
    [r => { r.model = 'unexpected-model'; }, 'UNEXPECTED_MODEL'],
    [r => { r.output[1].content = [{ type: 'refusal', refusal: canary }]; }, 'MODEL_REFUSAL'],
    [r => { r.output.push({ type: 'function_call', arguments: canary }); }, 'UNEXPECTED_OUTPUT_TYPE'],
    [r => { r.output.push(r.output[1]); }, 'INVALID_RESPONSE_OUTPUT'],
    [r => { r.output[1].content[0].text = '{'; }, 'INVALID_GENERATED_JSON'],
    [r => { r.output[1].content[0].text = 'x'.repeat(32769); }, 'GENERATED_TEXT_TOO_LARGE'],
  ]) { const r = envelope(); mutate(r); assert.throws(() => parseResponse(r), e => e.message === expected && !String(e).includes(canary)); }
});

test('provider errors, redirection and network failures never log or propagate provider text or retry', async () => {
  for (const status of [301, 400, 401, 403, 429, 500]) {
    let calls = 0; const ledger = [];
    await assert.rejects(generateOnce(canary, ledger, { fetchImpl: async () => {
      calls++; return new Response(canary, { status, headers: { location: 'https://evil.invalid' } });
    } }), e => e.message === `HTTP_${status}` && !String(e).includes(canary));
    assert.equal(calls, 1); assert.equal(ledger.length, 1); assert.ok(!JSON.stringify(ledger).includes(canary));
  }
  await assert.rejects(generateOnce(canary, [], { fetchImpl: async () => { throw new Error(canary); } }), /NETWORK_ERROR/);
});

test('credential echoes including escaped JSON copies are rejected before export', async () => {
  for (const body of [JSON.stringify({ ...envelope(), diagnostic: canary }),
    JSON.stringify({ ...envelope(), diagnostic: canary }).replaceAll('sk-synthetic', '\\u0073k-synthetic')]) {
    await assert.rejects(generateOnce(canary, [], { fetchImpl: async () => response(body) }),
      e => e.message === 'CREDENTIAL_ECHO_REJECTED' && !String(e).includes(canary));
  }
});

test('invalid media, declared/streamed oversized data, invalid UTF-8 and malformed JSON fail closed', async () => {
  for (const [make, expected] of [
    [() => new Response('{}', { headers: { 'content-type': 'text/html' } }), 'INVALID_CONTENT_TYPE'],
    [() => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '9999999' } }), 'BODY_TOO_LARGE'],
    [() => response('x'.repeat(LIMITS.max_response_bytes + 1)), 'BODY_TOO_LARGE'],
    [() => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }), 'INVALID_JSON_ENCODING'],
    [() => response('{'), 'INVALID_RESPONSE_JSON'],
  ]) await assert.rejects(generateOnce(canary, [], { fetchImpl: async () => make() }), e => e.message === expected);
});

test('deadline and cancellation abort the request and prevent retry; pre-cancel sends nothing', async () => {
  const waiting = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(canary)), { once: true });
  });
  const ledger = [];
  await assert.rejects(generateOnce(canary, ledger, { fetchImpl: waiting, timeoutMs: 10 }), /REQUEST_TIMEOUT/);
  assert.equal(ledger.length, 1);
  const controller = new AbortController();
  const pending = generateOnce(canary, [], { fetchImpl: waiting, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /CANCELLED/);
  const untouched = [];
  await assert.rejects(generateOnce(canary, untouched, { signal: controller.signal, fetchImpl: () => assert.fail('No request allowed') }), /CANCELLED/);
  assert.equal(untouched.length, 0);
});

test('deadline also aborts a stalled response body', async () => {
  await assert.rejects(generateOnce(canary, [], { timeoutMs: 10, fetchImpl: async (_url, { signal }) =>
    new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new Error(canary)), { once: true });
    } }), { headers: { 'content-type': 'application/json' } }) }), /REQUEST_TIMEOUT/);
});

test('usage remains numeric-only and optional; text comparison never claims quality', () => {
  const r = envelope(); r.usage.input_tokens = canary;
  assert.equal(parseResponse(r).usage, null);
  delete r.usage; assert.equal(parseResponse(r).usage, null);
  const comparison = compareQueries(generated(), reference);
  assert.equal(comparison.quality_verdict, null);
  for (const s of STREAMS) assert.deepEqual(comparison.streams[s], {
    query_count: 4, exact_reference_matches: 4, mean_best_reference_token_overlap: 1 });
});

test('OpenAI key validation rejects Google/password input and accepts long project keys without echo', async () => {
  for (const key of ['AIza' + 'a'.repeat(30), 'password', 'sk-too_short', 'sk-' + 'a'.repeat(510), canary + '\r\nHEADER']) {
    assert.throws(() => validateKey(key), /INVALID_OPENAI_KEY_FORMAT/);
  }
  const key = 'sk-proj-' + 'a'.repeat(300), { input, output } = terminal();
  const pending = readOpenAIKey(input, output);
  input.emit('data', '\r\n'); input.emit('data', 'mistake\u0015');
  input.emit('data', key.slice(0, 100)); input.emit('data', key.slice(100) + 'x\b\r\n');
  assert.equal(await pending, key); assert.ok(!output.text.includes(key));
  assert.ok(!output.text.includes('mistake')); assert.ok(output.text.includes('*****'));
  assert.equal(input.isRaw, false); assert.equal(input.paused, true); assert.equal(input.listenerCount('data'), 0);
});

test('key-input cancellation, EOF, invalid paste and non-TTY paths restore terminal without disclosure', async () => {
  for (const ending of ['\u0003', '\u001b', '\r', 'end', 'error']) {
    const { input, output } = terminal(); const pending = readOpenAIKey(input, output);
    input.emit('data', ending === '\r' ? 'bad' : canary);
    if (ending === 'end' || ending === 'error') input.emit(ending, new Error(canary));
    else input.emit('data', ending);
    await assert.rejects(pending, e => !String(e).includes(canary));
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0); assert.ok(!output.text.includes(canary));
  }
  const { input, output } = terminal(); input.isTTY = false;
  await assert.rejects(readOpenAIKey(input, output), /INTERACTIVE_TERMINAL_REQUIRED/);
});
