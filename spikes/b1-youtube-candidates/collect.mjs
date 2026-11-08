import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { SafeError, validatePlan, collect, createClient, rankCandidates, makeRatingPacket, toCsv } from './core.mjs';

import { readKey } from './key-input.mjs';

const root = new URL('../../', import.meta.url);
const plan = validatePlan(JSON.parse(await readFile(new URL('./intents.json', import.meta.url), 'utf8')));
const limits = { search_requests: 12, metadata_requests: 6, results_per_query: 25,
  pagination: false, automatic_retries: 0, inference_requests: 0 };

const sourceHashes = {};
for (const name of ['intents.json', 'core.mjs', 'key-input.mjs', 'collect.mjs', 'b1.test.mjs']) {
  sourceHashes[name] = createHash('sha256').update(await readFile(new URL(`./${name}`, import.meta.url))).digest('hex');
}
if (process.argv.length === 3 && process.argv[2] === '--plan') {
  const report = { spike: 'B1', status: 'READY_FOR_LOCAL_KEY_ENTRY', verdict: null,
    recorded_at: new Date().toISOString(), network_requests: 0, limits,
    expected_quota: { search_bucket_units: 12, other_bucket_units_max: 6, project_usage_verified: false },
    source_sha256: sourceHashes, plan };
  await writeFile(new URL('results/b1-preflight.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} else if (process.argv.length !== 2) {
  console.error('Usage: node spikes/b1-youtube-candidates/collect.mjs [--plan]');
  process.exitCode = 2;
} else {
  const runId = `${Date.now()}-${randomUUID()}`;
  const report = { spike: 'B1', run_id: runId, recorded_at: new Date().toISOString(),
    status: 'BLOCKED', verdict: null, limits, requests: [], inference_requests: 0,
    ratings_completed: false, llm_comparison_completed: false, source_sha256: sourceHashes };
  let key;
  try {
    console.log('MyTube B1: public video metadata only; no YouTube account/history access.');
    console.log('At most 12 searches + 6 metadata requests. No retries, pagination, or AI calls.');
    console.log('The key stays in process memory and is sent only to the Google YouTube API.');
    key = await readKey();
    const request = createClient(key, report.requests);
    const data = await collect(plan, request);
    key = undefined;
    const rankings = {}, tasks = [], mapping = [];
    for (const intent of plan.intents) {
      const ranked = rankCandidates(intent, data.candidates.filter(v => v.intent === intent.id));
      rankings[intent.id] = ranked;
      const packet = makeRatingPacket(intent, ranked);
      tasks.push(...packet.tasks);
      mapping.push(...packet.mapping);
    }
    const dataPath = `results/b1/${runId}/`;
    const privatePath = `.private/b1/${runId}/`;
    await mkdir(new URL(dataPath, root), { recursive: true });
    await mkdir(new URL(privatePath, root), { recursive: true });
    const outputs = {
      [`${dataPath}candidates.json`]: JSON.stringify(data, null, 2) + '\n',
      [`${dataPath}candidates.csv`]: toCsv(['intent', 'video_id', 'title', 'channel', 'duration_seconds',
        'published_at', 'description', 'url', 'originating_queries', 'best_search_rank', 'live_status'], data.candidates),
      [`${privatePath}rankings.json`]: JSON.stringify(rankings, null, 2) + '\n',
      [`${privatePath}rating-map.json`]: JSON.stringify(mapping, null, 2) + '\n',
      [`${privatePath}ratings.csv`]: toCsv(['item_id', 'intent', 'title', 'channel', 'duration_minutes', 'url',
        'relevant', 'want_to_watch', 'already_known', 'perceived_quality', 'short', 'notes'], tasks),
    };
    report.output_sha256 = {};
    for (const [path, content] of Object.entries(outputs)) {
      await writeFile(new URL(path, root), content, { flag: 'wx' });
      report.output_sha256[path] = createHash('sha256').update(content).digest('hex');
    }
    report.status = 'COLLECTED_AWAITING_HUMAN_RATINGS';
    report.unique_search_ids = data.unique_search_ids;
    report.missing_metadata_count = data.missing_metadata_ids.length;
    report.intents = Object.entries(rankings).map(([id, r]) => ({ id, eligible: r.eligible_count,
      search_top_count: r.search_baseline.length, keyword_top_count: r.keyword_baseline.length }));
    report.rating_file = `${privatePath}ratings.csv`;
  } catch (error) {
    report.failure_code = error instanceof SafeError ? error.message : 'LOCAL_PROCESSING_ERROR';
    const inputHelp = {
      API_KEY_LENGTH_INVALID: 'The input length is not valid. Copy the actual API key value from Google Cloud, not the key name or project ID.',
      API_KEY_CHARACTERS_INVALID: 'The input contains unsupported characters. Copy only the actual key value, without labels or quotes.',
      INVALID_KEY_INPUT: 'Unsupported terminal input. Use the terminal Paste action to insert only the actual key value.',
    };
    if (inputHelp[report.failure_code]) console.log(inputHelp[report.failure_code]);
    process.exitCode = 1;
  } finally {
    key = undefined;
    report.documented_quota_estimate = {
      search_bucket_units: report.requests.filter(r => r.endpoint === 'search').length,
      other_bucket_units: report.requests.filter(r => r.endpoint === 'videos').length,
      provider_usage_measured: false,
    };
    const path = `results/b1-run-${runId}.json`;
    await writeFile(new URL(path, root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
    console.log(`Sanitized evidence: ${path}`);
    console.log('Collection is not a quality verdict. Do not share the API key or private ratings.');
  }
}
