import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { QueryError, buildRequest, generateOnce, compareQueries, MODEL, LIMITS, INTENTION, STREAMS } from './core.mjs';
import { readOpenAIKey } from './key-input.mjs';
import { generatedFixture, responseFixture } from './fixtures.mjs';
import { toCsv } from '../b1-youtube-candidates/core.mjs';

const root = new URL('../../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] ?? '--plan';
if (process.argv.length > 3 || !['--plan', '--check', '--live'].includes(mode)) {
  console.error('Usage: node spikes/a3-query-generation/run.mjs [--plan|--check|--live]');
  process.exitCode = 2;
} else {
  const runId = `${Date.now()}-${randomUUID()}`;
  const report = { spike: 'A3', run_id: runId, recorded_at: new Date().toISOString(), mode,
    status: 'BLOCKED', verdict: null, model: MODEL, limits: LIMITS, requests: [],
    inference_requests: 0, google_requests: 0, oauth_attempts: 0, consent: 'NOT_REQUESTED',
    synthetic_fixture: mode === '--check', semantic_quality_assessed: false, billing_verified: false,
    source_sha256: {}, output_sha256: {} };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let key;
  try {
    const sourcePaths = ['core.mjs', 'key-input.mjs', 'run.mjs', 'fixtures.mjs', 'query.test.mjs']
      .map(n => `spikes/a3-query-generation/${n}`);
    sourcePaths.push('spikes/b1-controlled-discovery/plan.json', 'spikes/b1-youtube-candidates/core.mjs');
    for (const path of sourcePaths) report.source_sha256[path] = hash(await readFile(new URL(path, root)));
    const reference = JSON.parse(await readFile(new URL('spikes/b1-controlled-discovery/plan.json', root), 'utf8'));
    const baselineReport = JSON.parse(await readFile(new URL('results/b11-run-1794082922012-ec99cd17-1777-42bf-8ccb-343a44c6ed85.json', root), 'utf8'));
    if (report.source_sha256['spikes/b1-controlled-discovery/plan.json'] !== baselineReport.source_sha256['spikes/b1-controlled-discovery/plan.json']
      || reference.intention !== INTENTION) throw new QueryError('REFERENCE_PLAN_CHANGED');
    report.reference_run = baselineReport.run_id;
    report.request_sha256 = hash(JSON.stringify(buildRequest()));
    if (mode === '--plan') {
      report.status = 'READY_FOR_CONSENTED_LOCAL_KEY_ENTRY';
      report.request_preview = buildRequest();
    } else {
      let result;
      if (mode === '--check') {
        const fixtureLedger = [];
        result = await generateOnce('sk-synthetic_offline_fixture_not_a_real_key', fixtureLedger, {
          fetchImpl: async () => new Response(JSON.stringify(responseFixture(generatedFixture(reference))),
            { headers: { 'content-type': 'application/json' } }),
        });
        report.simulated_request_count = fixtureLedger.length;
      } else {
        console.log(`MyTube A3: at most ONE OpenAI Responses request using ${MODEL}.`);
        console.log(`Sent to OpenAI: "${INTENTION}" plus fixed instructions and an output schema.`);
        console.log('No YouTube history, account data, collected videos, Google calls, tools, or automatic retries.');
        console.log('Uses your API account credits/billing, not ChatGPT sign-in. Maximum output: 4096 tokens.');
        console.log('Your key stays in process memory. Only validated queries and sanitized evidence are saved locally.');
        console.log('store:false is requested; this does not guarantee zero provider retention.');
        key = await readOpenAIKey();
        report.consent = 'KEY_SUBMITTED_AFTER_REQUEST_AND_USAGE_NOTICE';
        process.on('SIGINT', cancel);
        result = await generateOnce(key, report.requests, { signal: controller.signal });
        key = undefined;
        report.usage = result.usage;
      }
      const comparison = compareQueries(result.generated, reference);
      const directory = `.private/${mode === '--check' ? 'a3-fixtures' : 'a3'}/${runId}/`;
      await mkdir(new URL(directory, root), { recursive: true });
      const rows = STREAMS.flatMap(s => result.generated.streams[s].queries.map((q, i) => ({
        stream: s, query_index: i, query: q.query, why: q.why,
        underlying_interest: result.generated.underlying_interests[q.interest_index],
        synthetic_fixture: mode === '--check',
      })));
      const outputs = {
        'query-plan.json': JSON.stringify({ synthetic_fixture: mode === '--check', generated: result.generated }, null, 2) + '\n',
        'queries.csv': toCsv(['synthetic_fixture', 'stream', 'query_index', 'query', 'why', 'underlying_interest'], rows),
      };
      for (const [name, contents] of Object.entries(outputs)) {
        await writeFile(new URL(directory + name, root), contents, { flag: 'wx' });
        report.output_sha256[directory + name] = hash(contents);
      }
      report.query_plan_file = directory + 'query-plan.json';
      report.comparison = comparison;
      report.structured_response_validated = true;
      report.status = mode === '--check' ? 'OFFLINE_CHECK_PASSED' : 'AI_QUERY_PLAN_GENERATED';
    }
  } catch (error) {
    report.failure_code = error instanceof QueryError ? error.message : 'LOCAL_PROCESSING_ERROR';
    process.exitCode = 1;
  } finally {
    key = undefined;
    process.off('SIGINT', cancel);
    report.inference_requests = report.requests.length;
    await mkdir(new URL('results/', root), { recursive: true });
    const path = `results/a3-run-${runId}.json`;
    await writeFile(new URL(path, root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, failure_code: report.failure_code,
      model: MODEL, synthetic_fixture: report.synthetic_fixture, inference_requests: report.inference_requests,
      google_requests: 0, structured_response_validated: report.structured_response_validated ?? false,
      query_counts: report.comparison ? Object.fromEntries(STREAMS.map(s => [s, report.comparison.streams[s].query_count])) : undefined,
      usage: report.usage, query_plan_file: report.query_plan_file, evidence: path }, null, 2));
    if (report.failure_code === 'HTTP_401') console.log('OpenAI rejected authentication. Verify the API key locally; do not paste it into chat.');
    if (report.failure_code === 'HTTP_403' || report.failure_code === 'HTTP_404') console.log('Check project permissions and model access locally. No alternate model or retry was attempted.');
    if (report.failure_code === 'HTTP_429') console.log('A rate or account-usage limit was reached. Check the API dashboard; no retry was attempted.');
    if (report.failure_code === 'INVALID_OPENAI_KEY_FORMAT') console.log('Use the OpenAI API key value beginning with sk-, not the Google key, a token, or a password.');
    console.log('Schema validation is not a recommendation-quality verdict. No generated query was executed.');
  }
}
