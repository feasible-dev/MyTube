import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { runLogin } from '../a1-openai-login/login.mjs';
import { Failure, requireThat } from '../a1-openai-login/protocol.mjs';
import { toCsv } from '../b1-youtube-candidates/core.mjs';
import { compareQueries, STREAMS } from './core.mjs';
import { chatgptRequest, validateChatgptResponse } from './chatgpt-task.mjs';

const root = new URL('../../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const sources = ['spikes/a1-openai-login/login.mjs', 'spikes/a1-openai-login/flow.mjs',
    'spikes/a1-openai-login/protocol.mjs', 'spikes/a1-openai-login/callback.mjs',
    'spikes/a3-query-generation/core.mjs', 'spikes/a3-query-generation/chatgpt-task.mjs',
    'spikes/a3-query-generation/chatgpt.mjs', 'spikes/a3-query-generation/chatgpt.test.mjs',
    'spikes/b1-controlled-discovery/plan.json', 'spikes/b1-youtube-candidates/core.mjs'];
  const hashes = {};
  for (const path of sources) hashes[path] = hash(await readFile(new URL(path, root)));
  const reference = JSON.parse(await readFile(new URL('spikes/b1-controlled-discovery/plan.json', root), 'utf8'));
  const baseline = JSON.parse(await readFile(new URL('results/b11-run-1794082922012-ec99cd17-1777-42bf-8ccb-343a44c6ed85.json', root), 'utf8'));
  requireThat(hashes['spikes/b1-controlled-discovery/plan.json'] === baseline.source_sha256['spikes/b1-controlled-discovery/plan.json'], 'REFERENCE_PLAN_CHANGED');
  let accepted;
  await runLogin({ spike: 'A3-ChatGPT', notices: [
    'OpenAI receives only the fixed public NASA/Challenger intention, instructions and query schema.',
    'Produces four DIRECT, four ADJACENT and four WILDCARD queries. No Google calls or history access.',
    'Uses a model from your account catalog. No API key or separate API billing setup is requested.',
    'The ChatGPT route does not support a hard output-token cap; local limits are 120 seconds and 2 MiB.',
  ], inferenceTask: { build: chatgptRequest, validate: validateChatgptResponse,
    accept: value => { accepted = value; } },
  finalizeReport: async report => {
    report.source_sha256 = hashes;
    report.google_requests = 0;
    report.credential_mode = 'CHATGPT_OAUTH_MEMORY_ONLY';
    report.semantic_quality_assessed = false;
    report.output_token_cap = null;
    report.inference_deadline_ms = 120000;
    report.stream_limit_bytes = 2 * 1024 * 1024;
    report.inference_retries = 0;
    if (!accepted) return;
    requireThat(report.status === 'TECHNICAL_PASS' && report.session_revocation === 'ACKNOWLEDGED', 'CLEANUP_REQUIRED');
    const directory = `.private/a3-chatgpt/${Date.now()}-${randomUUID()}/`;
    await mkdir(new URL(directory, root), { recursive: true, mode: 0o700 });
    const rows = STREAMS.flatMap(s => accepted.generated.streams[s].queries.map((q, index) => ({
      stream: s, query_index: index, query: q.query, why: q.why,
      underlying_interest: accepted.generated.underlying_interests[q.interest_index],
    })));
    const outputs = {
      'query-plan.json': JSON.stringify({ synthetic_fixture: false, generated: accepted.generated }, null, 2) + '\n',
      'queries.csv': toCsv(['stream', 'query_index', 'query', 'why', 'underlying_interest'], rows),
    };
    report.output_sha256 = {};
    for (const [name, content] of Object.entries(outputs)) {
      await writeFile(new URL(directory + name, root), content, { flag: 'wx', mode: 0o600 });
      report.output_sha256[directory + name] = hash(content);
    }
    report.query_plan_file = directory + 'query-plan.json';
    report.comparison = compareQueries(accepted.generated, reference);
    report.usage = accepted.usage;
    report.request_sha256 = hash(JSON.stringify(chatgptRequest(report.model)));
    accepted = undefined;
  } });
}
main().catch(error => {
  console.error(error instanceof Failure ? error.message : 'LOCAL_RUNTIME_ERROR');
  console.error('Stopped. Never share tokens, callback URLs, or account credentials.');
  process.exitCode = 1;
});
