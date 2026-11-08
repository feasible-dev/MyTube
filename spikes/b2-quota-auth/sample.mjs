import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readKey } from '../b1-youtube-candidates/key-input.mjs';
import { SafeError } from '../b1-youtube-candidates/core.mjs';
import { client, sampleFeeds } from './public-feed.mjs';

const root = new URL('../../', import.meta.url);
const b1 = '1794078880207-7c695f76-0cf1-4fcd-9bf2-bb8aa9416367';
const report = { spike: 'B2', run_id: `${Date.now()}-${randomUUID()}`, recorded_at: new Date().toISOString(),
  status: 'BLOCKED', verdict: null, requests: [], search_requests: 0, inference_requests: 0,
  oauth_attempts: 0, source_b1_run: b1, scope: 'Public channel uploads only; not user subscriptions or viewing history.' };
try {
  const source_sha256 = {};
  for (const path of ['spikes/b2-quota-auth/sample.mjs', 'spikes/b2-quota-auth/public-feed.mjs',
    'spikes/b1-youtube-candidates/key-input.mjs', 'spikes/b1-youtube-candidates/core.mjs']) {
    source_sha256[path] = createHash('sha256').update(await readFile(new URL(path, root))).digest('hex');
  }
  report.source_sha256 = source_sha256;
  const readVerified = async path => {
    const bytes = await readFile(new URL(path, root));
    const original = JSON.parse(await readFile(new URL(`results/b1-run-${b1}.json`, root), 'utf8'));
    if (createHash('sha256').update(bytes).digest('hex') !== original.output_sha256[path]) throw new SafeError('B1_EVIDENCE_CHANGED');
    return JSON.parse(bytes.toString('utf8'));
  };
  const data = await readVerified(`results/b1/${b1}/candidates.json`);
  const rankings = await readVerified(`.private/b1/${b1}/rankings.json`);
  const planBytes = await readFile(new URL('spikes/b1-youtube-candidates/intents.json', root));
  const original = JSON.parse(await readFile(new URL(`results/b1-run-${b1}.json`, root), 'utf8'));
  if (createHash('sha256').update(planBytes).digest('hex') !== original.source_sha256['intents.json']) throw new SafeError('B1_PLAN_CHANGED');
  const plan = JSON.parse(planBytes.toString('utf8'));
  const seeds = plan.intents.map(intent => ({ intent: intent.id, video_id: rankings[intent.id].search_baseline[0].video_id }));
  console.log('MyTube B2: sample three public channel feeds selected from B1.');
  console.log('At most 8 read-only Google calls; zero search, AI, OAuth, or history access. No retries.');
  console.log('Use the existing dedicated API/IP-restricted key. Its value is never saved.');
  const result = await sampleFeeds(seeds, plan.intents, data.candidates, client(await readKey(), report.requests));
  report.status = 'PUBLIC_FEEDS_COLLECTED';
  report.result = result;
} catch (error) {
  report.failure_code = error instanceof SafeError ? error.message : 'LOCAL_PROCESSING_ERROR';
  process.exitCode = 1;
} finally {
  report.documented_other_bucket_units_estimate = report.requests.length;
  report.provider_quota_meter_verified = false;
  const path = `results/b2-run-${report.run_id}.json`;
  await writeFile(new URL(path, root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const { result, ...summary } = report;
  console.log(JSON.stringify({ ...summary, result: result ? { public_channels: result.public_channels,
    unique_playlist_video_ids: result.unique_playlist_video_ids, missing_metadata_count: result.missing_metadata_count,
    samples: result.samples.map(({ videos, ...counts }) => counts) } : undefined }, null, 2));
  console.log(`Evidence: ${path}`);
}
