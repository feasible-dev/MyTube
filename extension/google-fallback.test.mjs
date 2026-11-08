import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleFallbackFetch, createGoogleGate, waitForGoogle } from './google-fallback.mjs';
import { fetchYouTubeResults } from './youtube-live.mjs';
const url = 'https://www.googleapis.com/youtube/v3/search';
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
test('temporary rate limiting retries once after Retry-After; other queued calls share the cooldown', async () => {
  let calls = 0; const waits = [];
  const fetchImpl = createGoogleFallbackFetch(async () => { calls++; return json({}, 429, { 'retry-after': '3' }); }, {
    wait: async ms => { waits.push(ms); }, now: () => 1000,
  });
  await assert.rejects(fetchImpl(url, {}), { code: 'RATE_LIMITED' });
  await assert.rejects(fetchImpl(url, {}), { code: 'RATE_LIMITED' });
  assert.equal(calls, 2); assert.deepEqual(waits, [3000]);
});
test('a transient retry can recover; daily quota and long Retry-After never trigger immediate retries', async () => {
  let calls = 0;
  const fetchImpl = createGoogleFallbackFetch(async () => ++calls === 1 ? json({}, 429) : json({ items: [] }), { wait: async () => {} });
  assert.equal((await fetchImpl(url, {})).status, 200); assert.equal(calls, 2);
  for (const response of [() => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403), () => json({}, 429, { 'retry-after': '120' })]) {
    let denied = 0;
    const limited = createGoogleFallbackFetch(async () => { denied++; return response(); }, { wait: () => assert.fail('No retry') });
    await assert.rejects(limited(url, {})); await assert.rejects(limited(url, {})); assert.equal(denied, 1);
  }
});
test('bounded error parsing distinguishes quota from rate limit without reflecting provider data', async () => {
  for (const [status, reason, code] of [[403, 'quotaExceeded', 'QUOTA_EXCEEDED'], [429, 'quotaExceeded', 'QUOTA_EXCEEDED'], [403, 'rateLimitExceeded', 'RATE_LIMITED'], [429, 'userRateLimitExceeded', 'RATE_LIMITED'], [403, 'insufficientPermissions', 'ACCESS_OR_QUOTA_DENIED']]) {
    await assert.rejects(fetchYouTubeResults({ query: 'Azores history', token: 'TOKEN_CANARY_123456789',
      fetchImpl: async () => json({ error: { message: 'PRIVATE_PROVIDER_CANARY', errors: [{ reason }] } }, status) }), error => error.code === code && !String(error).includes('CANARY'));
  }
});
test('cancelling a queued request removes it; two workers allow fast responses past a slow call', async () => {
  const gate = createGoogleGate(); let release; const pending = new Promise(resolve => { release = resolve; }); let calls = 0;
  const fetchImpl = createGoogleFallbackFetch(async () => { calls++; await pending; return json({ items: [] }); }, { gate });
  const a = fetchImpl(url, {}), b = fetchImpl(url, {}), c = new AbortController();
  const queued = fetchImpl(url, { signal: c.signal }); c.abort();
  await assert.rejects(queued, { code: 'CANCELLED' }); release(); await Promise.all([a, b]);
  assert.equal(calls, 2); assert.equal(gate.active, 0); assert.equal(gate.waiters.length, 0);
  const abort = new AbortController(); const waiting = waitForGoogle(10000, abort.signal); abort.abort();
  await assert.rejects(waiting, { code: 'CANCELLED' });
});
