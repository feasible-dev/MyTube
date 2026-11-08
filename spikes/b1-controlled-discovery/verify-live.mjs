import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { rankExperiment, streams, validateExperiment } from './core.mjs';

// Pinned public experiment only: no credentials, private ratings, or network access.
const root = new URL('../../', import.meta.url);
const runId = '1794082922012-ec99cd17-1777-42bf-8ccb-343a44c6ed85';
const dataPath = `results/b11/${runId}/`;
const read = path => readFile(new URL(path, root));
const json = async path => JSON.parse((await read(path)).toString('utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = await json(`results/b11-run-${runId}.json`);
assert.equal(report.run_id, runId);
assert.equal(report.mode, '--live');
assert.equal(report.status, 'STREAM_CANDIDATES_COLLECTED');
assert.equal(report.inference_requests, 0);
assert.equal(report.oauth_attempts, 0);
assert.equal(report.quality_assessed, false);
assert.equal(report.manual_ratings_created, false);
assert.equal(report.verdict, null);
assert.equal(report.requests.length, 18);
assert.ok(report.requests.every(r => r.attempted && r.http_status === 200 && r.response_bytes > 0));
assert.deepEqual(report.request_counts, { search: 12, metadata: 6 });
assert.equal(report.requests.filter(r => r.endpoint === 'search').length, 12);
assert.equal(report.requests.filter(r => r.endpoint === 'videos').length, 6);
const sourcePaths = ['spikes/b1-controlled-discovery/plan.json', 'spikes/b1-controlled-discovery/core.mjs',
  'spikes/b1-controlled-discovery/run.mjs', 'spikes/b1-controlled-discovery/discovery.test.mjs',
  'spikes/b1-youtube-candidates/core.mjs', 'spikes/b1-youtube-candidates/key-input.mjs'];
const outputPaths = ['candidates.json', 'rankings.json', 'recommendations.csv'].map(n => dataPath + n);
assert.deepEqual(Object.keys(report.source_sha256).sort(), [...sourcePaths].sort());
assert.deepEqual(Object.keys(report.output_sha256).sort(), [...outputPaths].sort());
for (const path of sourcePaths) assert.equal(hash(await read(path)), report.source_sha256[path], 'Source hash mismatch');
for (const path of outputPaths) assert.equal(hash(await read(path)), report.output_sha256[path], 'Output hash mismatch');
const plan = validateExperiment(await json('spikes/b1-controlled-discovery/plan.json'));
assert.deepEqual(report.plan, plan);
const data = await json(dataPath + 'candidates.json');
const saved = await json(dataPath + 'rankings.json');
const ranked = rankExperiment(plan, data.candidates);
assert.deepEqual(ranked, saved);
assert.deepEqual(rankExperiment(plan, [...data.candidates].reverse()), saved);
assert.equal(data.query_results.length, 12);
for (const spec of plan.intents) for (const query of spec.queries) {
  const entries = data.query_results.filter(v => v.intent === spec.id && v.query === query);
  assert.equal(entries.length, 1);
  assert.ok(Number.isInteger(entries[0].returned) && entries[0].returned >= 0 && entries[0].returned <= 25);
}
const ids = new Set(data.candidates.map(v => v.video_id));
assert.equal(ids.size + data.missing_metadata_ids.length, data.unique_search_ids);
assert.equal(data.unique_search_ids, report.unique_search_ids);
assert.equal(data.missing_metadata_ids.length, report.missing_metadata_count);
for (const candidate of data.candidates) {
  const spec = plan.intents.find(s => s.id === candidate.intent);
  assert.ok(spec && candidate.origins.length > 0);
  for (const origin of candidate.origins) {
    assert.equal(origin.intent, spec.id);
    assert.equal(origin.query, spec.queries[origin.query_index]);
    assert.ok(Number.isInteger(origin.search_rank) && origin.search_rank >= 1 && origin.search_rank <= 25);
  }
}
for (const method of ['search_baseline', 'diversified']) {
  const rows = Object.values(saved[method]).flat();
  assert.equal(rows.length, new Set(rows.map(v => v.video_id)).size);
  assert.ok(rows.every(v => ids.has(v.video_id) && v.quality === 'UNASSESSED' && v.personal_novelty === null));
}
assert.deepEqual(saved.eligible_counts, report.eligible_counts);
const selectedCounts = Object.fromEntries(streams.map(s => [s, saved.diversified[s].length]));
assert.deepEqual(selectedCounts, report.selected_counts);
assert.equal(report.cross_stream_duplicates, 0);
const baselineOverlap = Object.fromEntries(streams.map(s => [s,
  saved.diversified[s].filter(v => saved.search_baseline[s].some(b => b.video_id === v.video_id)).length]));
assert.deepEqual(baselineOverlap, report.baseline_overlap);
const evidence = { spike: 'B1.1', source_run: runId, verified_at: new Date().toISOString(),
  status: 'LIVE_ARTIFACTS_VERIFIED_OFFLINE', verdict: null, network_requests_this_check: 0,
  source_hashes_verified: true, output_hashes_verified: true, rankings_reproduced: true,
  query_provenance_verified: true, unique_search_ids: data.unique_search_ids,
  missing_metadata_count: data.missing_metadata_ids.length, eligible_counts: saved.eligible_counts,
  selected_counts: selectedCounts, cross_stream_duplicates: 0, baseline_overlap: baselineOverlap,
  quality_assessed: false, provider_quota_meter_verified: false,
  verifier_sha256: hash(await read('spikes/b1-controlled-discovery/verify-live.mjs')) };
await writeFile(new URL('results/b11-live-verification.json', root), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
