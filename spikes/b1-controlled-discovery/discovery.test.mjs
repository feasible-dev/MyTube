import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient, toCsv } from '../b1-youtube-candidates/core.mjs';
import { collectExperiment, rankExperiment, streams, validateExperiment } from './core.mjs';

const plan = JSON.parse(await readFile(new URL('./plan.json', import.meta.url), 'utf8'));
const id = n => `v${String(n).padStart(10, '0')}`;
const titles = {
  direct: 'NASA Challenger Columbia engineering failure investigation',
  adjacent: 'Nuclear reactor maritime engineering failure investigation',
  wildcard: 'Experimental submarine bridge engineering failure archive university lecture',
};
function candidate(intent, n, changes = {}) {
  return { intent, video_id: id(n), title: titles[intent], description: '', channel: `Channel ${n}`,
    published_at: '2001-01-01T00:00:00Z', views: null, duration_seconds: 1800, live_status: 'none',
    best_search_rank: 1, first_query_index: 0, origins: [{ intent, query: plan.intents.find(s => s.id === intent).queries[0],
      query_index: 0, search_rank: 1 }], ...changes };
}

test('plan has three distinct strategies and rejects duplicated queries or malformed vocabularies', () => {
  assert.equal(validateExperiment(plan), plan);
  for (const mutate of [p => { p.intents[1].queries[0] = p.intents[0].queries[0]; },
    p => { p.intents[0].bridge_terms = []; }, p => { p.intents[2].terms.push('bad term'); },
    p => { p.intents[1].min_minutes = 21; }]) {
    const invalid = structuredClone(plan); mutate(invalid);
    assert.throws(() => validateExperiment(invalid), /INVALID_/);
  }
});

test('full fixture collection uses twelve distinct searches and six metadata batches, with bounded credential-safe transport', async () => {
  const ledger = []; let search = 0;
  const key = 'synthetic_canary_credential_12345';
  const request = createClient(key, ledger, async (url, options) => {
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(options.headers['x-goog-api-key'], key);
    assert.equal(options.redirect, 'error');
    assert.ok(!url.href.includes(key));
    let items;
    if (url.pathname.endsWith('/search')) {
      items = Array.from({ length: 25 }, (_, i) => ({ id: { videoId: id(search * 25 + i) } })); search++;
    } else {
      assert.equal(url.searchParams.get('part'), 'snippet,contentDetails,statistics');
      items = url.searchParams.get('id').split(',').map(videoId => {
        const n = Number(videoId.slice(1)), intent = streams[Math.floor(n / 100)];
        return { id: videoId, snippet: { title: titles[intent], channelTitle: `Channel ${n}`, liveBroadcastContent: 'none' },
          contentDetails: { duration: 'PT30M' }, statistics: { viewCount: n % 2 ? '53' : undefined } };
      });
    }
    return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
  });
  const data = await collectExperiment(plan, request);
  assert.equal(search, 12); assert.equal(ledger.length, 18); assert.equal(data.unique_search_ids, 300);
  assert.equal(data.candidates.length, 300);
  assert.deepEqual(new Set(data.candidates.map(v => v.views)), new Set([null, 53]));
  assert.ok(!JSON.stringify({ data, ledger }).includes(key));
  const rankings = rankExperiment(plan, data.candidates);
  for (const s of streams) assert.equal(rankings.diversified[s].length, 10);
  await assert.rejects(request('search', {}), /REQUEST_BUDGET_EXCEEDED/);
  await assert.rejects(request('videos', {}), /REQUEST_BUDGET_EXCEEDED/);
});

test('cross-query and cross-stream overlap retains provenance and produces no repeated recommendations', async () => {
  const data = await collectExperiment(plan, async endpoint => endpoint === 'search'
    ? [{ id: { videoId: id(1) } }]
    : [{ id: id(1), snippet: { title: Object.values(titles).join(' '), channelTitle: 'Same channel', liveBroadcastContent: 'none' },
      contentDetails: { duration: 'PT30M' }, statistics: { viewCount: '99999999999999999999' } }]);
  assert.equal(data.candidates.length, 3);
  assert.ok(data.candidates.every(v => v.origins.length === 4 && v.views === null));
  for (const method of ['search_baseline', 'diversified']) {
    const lists = rankExperiment(plan, data.candidates)[method];
    assert.equal(Object.values(lists).flat().length, 1);
    assert.equal(lists.direct[0].video_id, id(1));
  }
});

test('rejects unknown/short/live durations and unrelated obscurity; never fabricates personal novelty or quality', () => {
  const candidates = [candidate('wildcard', 1),
    candidate('wildcard', 2, { duration_seconds: null }), candidate('wildcard', 3, { duration_seconds: 100 }),
    candidate('wildcard', 4, { live_status: 'live' }), candidate('wildcard', 5, { duration_seconds: 7201 }),
    candidate('wildcard', 6, { title: 'Obscure funny cats archive', views: 1 }),
    candidate('wildcard', 7, { title: 'Experimental submarine documentary' })];
  const result = rankExperiment(plan, candidates);
  assert.equal(result.eligible_counts.wildcard, 1);
  const selected = result.diversified.wildcard[0];
  assert.equal(selected.quality, 'UNASSESSED'); assert.equal(selected.personal_novelty, null);
  assert.equal(result.quality_verdict, null); assert.equal(result.semantic_model_used, false);
});

test('view counts and age never change ranks; shuffled inputs remain deterministic', () => {
  const candidates = streams.flatMap((s, i) => Array.from({ length: 4 }, (_, n) => candidate(s, i * 10 + n)));
  const ids = result => Object.fromEntries(streams.map(s => [s, result.diversified[s].map(v => v.video_id)]));
  const expected = ids(rankExperiment(plan, candidates));
  assert.deepEqual(ids(rankExperiment(plan, [...candidates].reverse())), expected);
  assert.deepEqual(ids(rankExperiment(plan, candidates.map((v, i) => ({ ...v,
    views: i % 2 ? 1 : 100000000, published_at: i % 2 ? '1970-01-01' : '2026-11-07' })))), expected);
});

test('incidental NASA and submarine mentions in description boilerplate do not establish DIRECT or WILDCARD membership', () => {
  const result = rankExperiment(plan, [
    candidate('direct', 1, { title: 'The Miracle Landing of TACA 110', description: titles.direct }),
    candidate('wildcard', 2, { title: 'American Soldiers Entered a German Castle', description: titles.wildcard }),
    candidate('adjacent', 3, { title: 'Funny cats compilation', description: titles.adjacent }),
    candidate('direct', 4, { title: 'Challenger engineering investigation', description: '' }),
  ]);
  assert.deepEqual(result.eligible_counts, { direct: 1, adjacent: 0, wildcard: 0 });
  assert.deepEqual(result.diversified.direct[0].signals.title_domain_terms, ['challenger']);
});

test('diversity selects a different domain/channel over redundant metadata', () => {
  const candidates = [candidate('adjacent', 1, { channel: 'A' }), candidate('adjacent', 2, { channel: 'A' }),
    candidate('adjacent', 3, { title: 'Aviation aircraft ship safety decisions accident', channel: 'B' })];
  const result = rankExperiment(plan, candidates, 2);
  assert.deepEqual(result.search_baseline.adjacent.map(v => v.video_id), [id(1), id(2)]);
  assert.deepEqual(result.diversified.adjacent.map(v => v.video_id), [id(1), id(3)]);
});

test('missing metadata is recorded and unsolicited IDs fail closed', async () => {
  const missing = await collectExperiment(plan, async endpoint => endpoint === 'search'
    ? [{ id: { videoId: id(1) } }] : []);
  assert.deepEqual(missing.missing_metadata_ids, [id(1)]);
  assert.deepEqual(missing.candidates, []);
  await assert.rejects(collectExperiment(plan, async endpoint => endpoint === 'search'
    ? [{ id: { videoId: id(1) } }] : [{ id: id(2) }]), /UNEXPECTED_VIDEO_ID/);
});

test('provider failure stops collection without retries or credential leakage', async () => {
  let calls = 0; const ledger = [], key = 'synthetic_canary_credential_12345';
  const request = createClient(key, ledger, async () => { calls++; return new Response(key, { status: 403 }); });
  await assert.rejects(collectExperiment(plan, request), e => e.message === 'HTTP_403' && !String(e).includes(key));
  assert.equal(calls, 1); assert.ok(!JSON.stringify(ledger).includes(key));
});

test('candidate validation rejects duplicates and unsafe IDs; exported provider text cannot become a formula or link', () => {
  const v = candidate('direct', 1);
  assert.throws(() => rankExperiment(plan, [v, v]), /INVALID_CANDIDATE_MEMBERSHIP/);
  assert.throws(() => rankExperiment(plan, [{ ...v, video_id: '../evil' }]), /INVALID_CANDIDATE/);
  assert.throws(() => rankExperiment(plan, [{ ...v, best_search_rank: NaN }]), /INVALID_CANDIDATE/);
  const r = rankExperiment(plan, [{ ...v, title: '=NASA Challenger engineering failure', url: 'https://evil.invalid' }]);
  assert.equal(r.diversified.direct[0].url, `https://www.youtube.com/watch?v=${id(1)}`);
  assert.ok(toCsv(['title'], r.diversified.direct).includes("'=NASA"));
});
