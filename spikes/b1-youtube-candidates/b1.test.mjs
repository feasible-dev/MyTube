import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { readKey } from './key-input.mjs';
import { collect, createClient, durationSeconds, normalizeVideo, rankCandidates, makeRatingPacket,
  csvCell, validatePlan } from './core.mjs';

function terminalFixture() {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, paused: false,
    setRawMode(value) { this.isRaw = value; }, setEncoding() {}, resume() {}, pause() { this.paused = true; } });
  const output = { isTTY: true, text: '', write(text) { this.text += text; } };
  return { input, output };
}

test('hidden prompt reprompts on empty CRLF and receives chunked paste without echo', async () => {
  const { input, output } = terminalFixture();
  const pending = readKey(input, output);
  input.emit('data', '\r\n');
  assert.equal((output.text.match(/No key received/g) ?? []).length, 1);
  input.emit('data', 'test_only_credential_');
  input.emit('data', 'canary_12345\r\n');
  assert.equal(await pending, 'test_only_credential_canary_12345');
  assert.equal((output.text.match(/\*/g) ?? []).length, 'test_only_credential_canary_12345'.length);
  assert.ok(!output.text.includes('test_only_credential_'));
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount('data'), 0);
});
test('hidden input supports correction and clearing without exposing previous text', async () => {
  const { input, output } = terminalFixture();
  const pending = readKey(input, output);
  input.emit('data', 'wrong\u0015test_only_credential_canary_1234x\b5\r');
  assert.equal(await pending, 'test_only_credential_canary_12345');
  assert.ok(!output.text.includes('wrong'));
  assert.ok(output.text.includes('*****' + '\b \b'.repeat(5)));
  assert.ok(output.text.includes('*\b \b*'));
});
test('hidden input distinguishes invalid length and characters with no input in errors', async () => {
  for (const [value, expected] of [['short', 'API_KEY_LENGTH_INVALID'],
    ['MyTube B1 local test value', 'API_KEY_CHARACTERS_INVALID']]) {
    const { input, output } = terminalFixture();
    const pending = readKey(input, output);
    input.emit('data', value + '\r');
    await assert.rejects(pending, e => e.message === expected && !String(e).includes(value));
    assert.ok(!output.text.includes(value));
    assert.equal(input.isRaw, false);
  }
});
test('cancel, EOF, and unsupported controls restore terminal mode without disclosure', async () => {
  for (const ending of ['cancel', 'end', 'invalid']) {
    const { input, output } = terminalFixture();
    const pending = readKey(input, output);
    input.emit('data', 'test_only_credential_canary_12345');
    if (ending === 'end') input.emit('end');
    else input.emit('data', ending === 'cancel' ? '\u0003' : '\u001b');
    await assert.rejects(pending, /CANCELLED|INPUT_CLOSED|INVALID_KEY_INPUT/);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('data'), 0);
    assert.ok(!output.text.includes('test_only_credential_canary_12345'));
  }
});
test('noninteractive key entry is refused without reading input', async () => {
  const { input, output } = terminalFixture(); input.isTTY = false;
  await assert.rejects(readKey(input, output), /INTERACTIVE_TERMINAL_REQUIRED/);
  assert.equal(input.listenerCount('data'), 0);
});

const plan = JSON.parse(await readFile(new URL('./intents.json', import.meta.url), 'utf8'));
const fakeKey = 'test_only_credential_canary_12345';
const json = (value, init = {}) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' }, ...init });
const video = (id = 'abcdefghijk', duration = 'PT30M') => ({ id,
  snippet: { title: 'Aviation accident investigation', description: 'Technical analysis report',
    channelTitle: 'Fixture only', publishedAt: '2020-01-01T00:00:00Z', liveBroadcastContent: 'none' },
  contentDetails: { duration } });

test('plan fixes exactly twelve bounded English queries', () => {
  assert.equal(validatePlan(plan), plan);
  const altered = structuredClone(plan);
  altered.intents[0].queries.push('extra query');
  assert.throws(() => validatePlan(altered), /INVALID_PLAN/);
});
test('duration parsing handles boundaries and rejects ambiguous or invalid durations', () => {
  for (const [input, expected] of [['PT15M', 900], ['PT1H30M', 5400], ['P1DT2H3M4S', 93784], ['PT1.5S', 1.5]]) {
    assert.equal(durationSeconds(input), expected);
  }
  for (const input of [undefined, '', 'P', 'PT', 'PT0S', 'P1Y', 'P1M', '-PT1M', 'P1DT', 'PTNaNS']) {
    assert.equal(durationSeconds(input), null);
  }
});
test('CSV quotes metacharacters and neutralizes formula prefixes after whitespace', () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  for (const value of ['=cmd()', ' +SUM(1,2)', '\t@x', '\r-1']) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('normal\ntext'), '"normal text"');
});
test('metadata cannot inject a link and missing duration stays unknown', () => {
  assert.throws(() => normalizeVideo(video('https://bad')), /INVALID_VIDEO_METADATA/);
  const v = video(); v.snippet.title = 'a\u202eb\u0000c'; delete v.contentDetails.duration;
  const result = normalizeVideo(v);
  assert.equal(result.duration_seconds, null);
  assert.equal(result.short, null);
  assert.equal(result.title, 'a b c');
  assert.equal(result.url, 'https://www.youtube.com/watch?v=abcdefghijk');
});
test('ranking excludes unknown, out-of-range, and live candidates; ties are stable', () => {
  const base = { ...normalizeVideo(video()), best_search_rank: 2, first_query_index: 0 };
  const rows = [base, { ...base, video_id: 'bbbbbbbbbbb', best_search_rank: 1 },
    { ...base, video_id: 'ccccccccccc', duration_seconds: null },
    { ...base, video_id: 'ddddddddddd', duration_seconds: 1199 },
    { ...base, video_id: 'eeeeeeeeeee', duration_seconds: 5401 },
    { ...base, video_id: 'fffffffffff', live_status: 'live' }];
  const ranked = rankCandidates(plan.intents[0], rows);
  assert.equal(ranked.eligible_count, 2);
  assert.deepEqual(ranked, rankCandidates(plan.intents[0], [...rows].reverse()));
  assert.equal(ranked.search_baseline[0].video_id, 'bbbbbbbbbbb');
  assert.equal(rankCandidates(plan.intents[0], []).eligible_count, 0);
});
test('rating packet hides methods and scores and deduplicates overlap', () => {
  const v = { ...normalizeVideo(video()), best_search_rank: 1, first_query_index: 0 };
  const packet = makeRatingPacket(plan.intents[0], rankCandidates(plan.intents[0], [v]));
  assert.equal(packet.tasks.length, 1);
  assert.equal(packet.mapping[0].memberships.length, 2);
  assert.equal(packet.tasks[0].item_id, packet.mapping[0].item_id);
  assert.ok(!JSON.stringify(packet.tasks).includes('baseline'));
  assert.ok(!Object.hasOwn(packet.tasks[0], 'keyword_score'));
});
test('key goes only in fixed Google header, redirects forbidden, and budget enforced', async () => {
  const ledger = [];
  const request = createClient(fakeKey, ledger, async (url, options) => {
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.ok(!url.href.includes(fakeKey));
    assert.equal(options.headers['x-goog-api-key'], fakeKey);
    assert.equal(options.redirect, 'error');
    return json({ items: [] });
  });
  for (let i = 0; i < 12; i++) await request('search', {});
  await assert.rejects(request('search', {}), /REQUEST_BUDGET_EXCEEDED/);
  await assert.rejects(request('other', {}), /INVALID_ENDPOINT/);
  await assert.rejects(request('videos', { key: fakeKey }), /INVALID_REQUEST_PARAMETERS/);
  await assert.rejects(request('videos', { pageToken: 'next' }), /INVALID_REQUEST_PARAMETERS/);
  assert.equal(ledger.length, 12);
  assert.ok(!JSON.stringify(ledger).includes(fakeKey));
});
test('provider errors and network errors cannot leak credential canaries', async () => {
  for (const fetchImpl of [async () => json({ error: fakeKey }, { status: 403 }),
    async () => { throw new Error(fakeKey); }, async () => json({ items: [], echo: fakeKey })]) {
    const ledger = [];
    await assert.rejects(createClient(fakeKey, ledger, fetchImpl)('search', {}), e => {
      assert.ok(!String(e).includes(fakeKey)); return true;
    });
    assert.equal(ledger.length, 1);
    assert.ok(!JSON.stringify(ledger).includes(fakeKey));
  }
});
test('malformed, oversized, and wrong-media bodies fail closed', async () => {
  const responses = [new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    json({ items: Array(26).fill({}) }), json({ missing: [] }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })];
  for (const response of responses) {
    await assert.rejects(createClient(fakeKey, [], async () => response)('search', {}),
      /INVALID_JSON|INVALID_CONTENT_TYPE|INVALID_RESPONSE|BODY_TOO_LARGE/);
  }
});
test('request deadline aborts without leaking error text', async () => {
  const request = createClient(fakeKey, [], async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error(fakeKey)), { once: true });
  }), 10);
  await assert.rejects(request('search', {}), /REQUEST_TIMEOUT/);
});
test('collection deduplicates globally, preserves query provenance and records missing metadata', async () => {
  const calls = [];
  const data = await collect(plan, async (endpoint, params) => {
    calls.push({ endpoint, params });
    return endpoint === 'search' ? [{ id: { videoId: 'abcdefghijk' } }, { id: { videoId: 'missing1234' } }]
      : [video()];
  });
  assert.equal(calls.filter(c => c.endpoint === 'search').length, 12);
  assert.equal(calls.filter(c => c.endpoint === 'videos').length, 1);
  assert.equal(data.unique_search_ids, 2);
  assert.deepEqual(data.missing_metadata_ids, ['missing1234']);
  assert.equal(data.candidates.length, 3);
  assert.equal(data.candidates[0].origins.length, 4);
  assert.ok(calls.every(c => !Object.hasOwn(c.params, 'videoDuration')));
});
test('full fixture run stays within twelve searches and six batches of fifty', async () => {
  let searches = 0, batches = 0;
  const data = await collect(plan, async (endpoint, params) => {
    if (endpoint === 'search') {
      const start = searches++ * 25;
      return Array.from({ length: 25 }, (_, i) => ({ id: { videoId: String(start + i).padStart(11, '0') } }));
    }
    batches++;
    assert.equal(params.id.split(',').length, 50);
    return params.id.split(',').map(id => video(id));
  });
  assert.equal(searches, 12); assert.equal(batches, 6); assert.equal(data.unique_search_ids, 300);
});
test('collection stops on first error and rejects unsolicited metadata IDs', async () => {
  let calls = 0;
  await assert.rejects(collect(plan, async () => { calls++; throw new Error('fixture'); }), /fixture/);
  assert.equal(calls, 1);
  await assert.rejects(collect(plan, async endpoint => endpoint === 'search'
    ? [{ id: { videoId: 'abcdefghijk' } }] : [video('unexpected1')]), /UNEXPECTED_VIDEO_ID/);
});
