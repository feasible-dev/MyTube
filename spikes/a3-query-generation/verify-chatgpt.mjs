import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chatgptRequest } from './chatgpt-task.mjs';
import { validateGenerated, compareQueries, STREAMS } from './core.mjs';

const runId = process.argv[2];
assert.equal(process.argv.length, 3, 'Supply exactly one A3-ChatGPT run ID');
assert.match(runId ?? '', /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root));
const json = async path => JSON.parse((await read(path)).toString('utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = await json(`results/a3-chatgpt-run-${runId}.json`);
assert.equal(report.spike, 'A3-ChatGPT');
assert.equal(report.status, 'TECHNICAL_PASS');
for (const field of ['oauth_attempted', 'identity_verified', 'plan_permission_granted', 'structured_response_validated']) {
  assert.equal(report[field], true);
}
assert.equal(report.session_revocation, 'ACKNOWLEDGED');
assert.equal(report.inference_requests, 1);
assert.equal(report.inference_http_status, 200);
assert.equal(report.google_requests, 0);
assert.equal(report.output_token_cap, null);
assert.equal(report.semantic_quality_assessed, false);
assert.equal(report.billing_verified, false);
assert.equal(report.verdict, null);
const sources = ['spikes/a1-openai-login/login.mjs', 'spikes/a1-openai-login/flow.mjs',
  'spikes/a1-openai-login/protocol.mjs', 'spikes/a1-openai-login/callback.mjs',
  'spikes/a3-query-generation/core.mjs', 'spikes/a3-query-generation/chatgpt-task.mjs',
  'spikes/a3-query-generation/chatgpt.mjs', 'spikes/a3-query-generation/chatgpt.test.mjs',
  'spikes/b1-controlled-discovery/plan.json', 'spikes/b1-youtube-candidates/core.mjs'];
assert.deepEqual(Object.keys(report.source_sha256).sort(), [...sources].sort());
for (const path of sources) assert.equal(hash(await read(path)), report.source_sha256[path], 'Source hash mismatch');
assert.match(report.query_plan_file, /^\.private\/a3-chatgpt\/\d+-[0-9a-f-]{36}\/query-plan\.json$/);
const outputDirectory = report.query_plan_file.slice(0, -'query-plan.json'.length);
const paths = ['query-plan.json', 'queries.csv'].map(name => outputDirectory + name);
assert.deepEqual(Object.keys(report.output_sha256).sort(), [...paths].sort());
for (const path of paths) assert.equal(hash(await read(path)), report.output_sha256[path], 'Output hash mismatch');
const plan = await json(report.query_plan_file);
assert.equal(plan.synthetic_fixture, false);
validateGenerated(plan.generated);
const reference = await json('spikes/b1-controlled-discovery/plan.json');
assert.deepEqual(compareQueries(plan.generated, reference), report.comparison);
assert.equal(hash(JSON.stringify(chatgptRequest(report.model))), report.request_sha256);
const evidence = { spike: 'A3-ChatGPT', source_run: runId, verified_at: new Date().toISOString(),
  status: 'LIVE_QUERY_PLAN_VERIFIED_OFFLINE', verdict: null, network_requests_this_check: 0,
  source_hashes_verified: true, output_hashes_verified: true, schema_revalidated: true,
  comparison_reproduced: true, inference_requests_in_source_run: 1, google_requests_in_source_run: 0,
  session_revocation_in_source_run: report.session_revocation,
  underlying_interest_count: plan.generated.underlying_interests.length,
  query_counts: Object.fromEntries(STREAMS.map(s => [s, plan.generated.streams[s].queries.length])),
  semantic_quality_assessed: false,
  verifier_sha256: hash(await read('spikes/a3-query-generation/verify-chatgpt.mjs')) };
await writeFile(new URL('results/a3-chatgpt-verification.json', root), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
