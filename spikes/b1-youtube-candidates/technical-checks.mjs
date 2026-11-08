import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { rankCandidates, validId, validatePlan } from './core.mjs';
import { assess } from './assessment.mjs';

// Offline inspection of existing files only. No credential input, network, or rating mutation.
const root = new URL('../../', import.meta.url);
const runId = process.argv[2] ?? '1794078880207-7c695f76-0cf1-4fcd-9bf2-bb8aa9416367';
assert.match(runId, /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
assert.ok(process.argv.length <= 3);
const read = path => readFile(new URL(path, root));
const json = async path => JSON.parse((await read(path)).toString('utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = await json(`results/b1-run-${runId}.json`);
assert.equal(report.status, 'COLLECTED_AWAITING_HUMAN_RATINGS');
const dataPath = `results/b1/${runId}/`, privatePath = `.private/b1/${runId}/`;
const paths = [`${dataPath}candidates.json`, `${dataPath}candidates.csv`,
  `${privatePath}rankings.json`, `${privatePath}rating-map.json`, `${privatePath}ratings.csv`];
const before = {};
for (const path of paths) {
  before[path] = hash(await read(path));
  assert.equal(before[path], report.output_sha256[path], 'Original output integrity mismatch');
}
for (const name of ['intents.json', 'core.mjs', 'key-input.mjs', 'collect.mjs', 'b1.test.mjs']) {
  assert.equal(hash(await read(`spikes/b1-youtube-candidates/${name}`)), report.source_sha256[name], 'Collector source changed since collection');
}
const plan = validatePlan(await json('spikes/b1-youtube-candidates/intents.json'));
const data = await json(`${dataPath}candidates.json`);
const saved = await json(`${privatePath}rankings.json`);
const mapping = await json(`${privatePath}rating-map.json`);
assert.equal(report.requests.length, 18);
assert.ok(report.requests.every(r => r.http_status === 200));
assert.equal(report.requests.filter(r => r.endpoint === 'search').length, 12);
assert.equal(report.requests.filter(r => r.endpoint === 'videos').length, 6);
assert.equal(report.inference_requests, 0);
assert.equal(data.query_results.length, 12);
assert.equal(data.missing_metadata_ids.length, 0);
assert.equal(new Set(data.candidates.map(v => v.video_id)).size, report.unique_search_ids);
assert.equal(new Set(mapping.map(row => row.item_id)).size, mapping.length);
const intentResults = [];
for (const intent of plan.intents) {
  const candidates = data.candidates.filter(v => v.intent === intent.id);
  assert.equal(new Set(candidates.map(v => v.video_id)).size, candidates.length);
  for (const v of candidates) {
    assert.ok(validId(v.video_id));
    assert.equal(v.url, `https://www.youtube.com/watch?v=${v.video_id}`);
    assert.ok(v.origins.length > 0);
    for (const origin of v.origins) {
      assert.equal(origin.intent, intent.id);
      assert.equal(origin.query, intent.queries[origin.query_index]);
      assert.ok(Number.isInteger(origin.search_rank) && origin.search_rank >= 1 && origin.search_rank <= 25);
    }
  }
  const ranked = rankCandidates(intent, candidates);
  assert.deepEqual(ranked, saved[intent.id]);
  assert.deepEqual(ranked, rankCandidates(intent, [...candidates].reverse()));
  const members = mapping.filter(row => row.intent === intent.id);
  const union = new Set();
  for (const method of ['search_baseline', 'keyword_baseline']) {
    assert.equal(ranked[method].length, 10);
    assert.equal(new Set(ranked[method].map(v => v.video_id)).size, 10);
    const mapped = members.flatMap(row => row.memberships.filter(m => m.method === method)
      .map(m => ({ rank: m.rank, video_id: row.video_id }))).sort((a, b) => a.rank - b.rank);
    assert.deepEqual(mapped, ranked[method].map((v, i) => ({ rank: i + 1, video_id: v.video_id })));
    for (const v of ranked[method]) {
      union.add(v.video_id);
      assert.ok(v.duration_seconds >= intent.min_minutes * 60 && v.duration_seconds <= intent.max_minutes * 60);
      assert.equal(v.live_status, 'none');
      assert.ok(Number.isInteger(v.keyword_score) && v.keyword_score >= 0);
    }
  }
  assert.equal(members.length, union.size);
  const overlap = ranked.search_baseline.filter(a => ranked.keyword_baseline.some(b => a.video_id === b.video_id)).length;
  intentResults.push({ intent: intent.id, candidates: candidates.length, eligible: ranked.eligible_count,
    search_top_count: 10, keyword_top_count: 10, shared_top_ten: overlap,
    identical_order: ranked.search_baseline.every((v, i) => v.video_id === ranked.keyword_baseline[i].video_id),
    saved_rankings_reproduced: true, reversed_input_stable: true,
    duration_and_live_status_checks_passed: true, rating_mapping_valid: true });
}

// This fixture uses invented identifiers and never touches the real rating sheet.
const fixture = await json('spikes/b1-youtube-candidates/synthetic-ratings.json');
assert.equal(fixture.data_kind, 'SYNTHETIC_ONLY');
const synthetic = assess(fixture.lists, fixture.ratings, fixture.data_kind);
const syntheticPath = 'results/b1-synthetic-assessment.json';
await writeFile(new URL(syntheticPath, root), JSON.stringify(synthetic, null, 2) + '\n');
assert.deepEqual(await json(syntheticPath), synthetic);
for (const path of paths) assert.equal(hash(await read(path)), before[path], 'Existing evidence was modified');
const sourceHashes = {};
for (const name of ['technical-checks.mjs', 'assessment.mjs', 'assessment.test.mjs', 'synthetic-ratings.json']) {
  sourceHashes[name] = hash(await read(`spikes/b1-youtube-candidates/${name}`));
}
const technical = { spike: 'B1', recorded_at: new Date().toISOString(), run_id: runId,
  status: 'TECHNICAL_PASS', scope: 'Offline reproducibility/integrity checks on the real dataset plus synthetic scoring/report checks.',
  product_verdict: null, recommendation_quality: 'UNASSESSED', human_labeling: 'DEFERRED_BY_USER',
  network_requests_this_check: 0, inference_requests_this_check: 0, existing_outputs_unchanged: true,
  original_source_hashes_verified: true, original_output_hashes_verified: true,
  real_rating_values_generated: false, unique_videos: report.unique_search_ids,
  intents: intentResults, synthetic_report: syntheticPath, source_sha256: sourceHashes };
await writeFile(new URL('results/b1-technical-checks.json', root), JSON.stringify(technical, null, 2) + '\n');
console.log(JSON.stringify(technical, null, 2));
