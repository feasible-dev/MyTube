import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Offline verification of the first successful public-feed experiment.
const root = new URL('../../', import.meta.url);
const runId = '1794081158060-18bce1d8-ea50-4d0b-8859-501d0c1c4a70';
const path = `results/b2-run-${runId}.json`;
const bytes = await readFile(new URL(path, root));
const run = JSON.parse(bytes.toString('utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(run.status, 'PUBLIC_FEEDS_COLLECTED');
assert.equal(run.search_requests, 0);
assert.equal(run.inference_requests, 0);
assert.equal(run.oauth_attempts, 0);
const expected = { videos: 4, channels: 1, playlistItems: 3 };
assert.equal(run.requests.length, 8);
for (const [endpoint, count] of Object.entries(expected)) {
  assert.equal(run.requests.filter(r => r.endpoint === endpoint).length, count);
}
assert.ok(run.requests.every(r => r.http_status === 200));
for (const file of ['spikes/b2-quota-auth/sample.mjs', 'spikes/b2-quota-auth/public-feed.mjs',
  'spikes/b1-youtube-candidates/key-input.mjs', 'spikes/b1-youtube-candidates/core.mjs']) {
  assert.equal(sha(await readFile(new URL(file, root))), run.source_sha256[file]);
}
const b1 = JSON.parse(await readFile(new URL(`results/b1-run-${run.source_b1_run}.json`, root), 'utf8'));
const candidatePath = `results/b1/${run.source_b1_run}/candidates.json`;
const candidateBytes = await readFile(new URL(candidatePath, root));
assert.equal(sha(candidateBytes), b1.output_sha256[candidatePath]);
const candidates = JSON.parse(candidateBytes.toString('utf8')).candidates;
const planBytes = await readFile(new URL('spikes/b1-youtube-candidates/intents.json', root));
assert.equal(sha(planBytes), b1.source_sha256['intents.json']);
const intents = JSON.parse(planBytes.toString('utf8')).intents;
assert.equal(run.result.samples.length, intents.length);
assert.equal(new Set(run.result.samples.map(s => s.intent)).size, intents.length);
const unique = new Set(), eligibleIds = new Set(), newIds = new Set();
const summary = run.result.samples.map(sample => {
  const intent = intents.find(i => i.id === sample.intent);
  assert.ok(intent);
  assert.equal(new Set(sample.videos.map(v => v.video_id)).size, sample.videos.length);
  assert.equal(sample.playlist_items, sample.videos.length); // This run reports no missing metadata.
  for (const video of sample.videos) {
    assert.match(video.video_id, /^[A-Za-z0-9_-]{11}$/);
    unique.add(video.video_id);
  }
  const eligible = sample.videos.filter(v => v.live_status === 'none' && Number.isFinite(v.duration_seconds)
    && v.duration_seconds >= intent.min_minutes * 60 && v.duration_seconds <= intent.max_minutes * 60);
  const oldIds = new Set(candidates.filter(v => v.intent === intent.id).map(v => v.video_id));
  const additional = eligible.filter(v => !oldIds.has(v.video_id));
  assert.equal(eligible.length, sample.eligible_by_duration_and_live_status);
  assert.equal(additional.length, sample.eligible_not_in_original_theme_pool);
  eligible.forEach(v => eligibleIds.add(v.video_id)); additional.forEach(v => newIds.add(v.video_id));
  return { intent: intent.id, playlist_items: sample.playlist_items,
    eligible_by_duration_and_live_status: eligible.length, eligible_not_in_original_theme_pool: additional.length };
});
assert.equal(unique.size, run.result.unique_playlist_video_ids);
assert.equal(run.result.missing_metadata_count, 0);
assert.equal(new Set(run.result.samples.map(s => s.channel_id)).size, run.result.public_channels);
assert.equal(sha(await readFile(new URL(path, root))), sha(bytes));
const evidence = { spike: 'B2', recorded_at: new Date().toISOString(), status: 'PUBLIC_FEED_TECHNICAL_PASS',
  run_id: runId, source_report_sha256: sha(bytes), source_hashes_match: true,
  counts_recomputed_from_saved_metadata: true, unique_videos: unique.size,
  unique_eligible_videos: eligibleIds.size, unique_eligible_videos_absent_from_respective_b1_theme: newIds.size,
  samples: summary, network_requests_during_verification: 0,
  google_oauth_tested: false, provider_quota_meter_verified: false, recommendation_quality: 'UNASSESSED',
  b2_overall_verdict: 'CONDITIONAL_GO_FOR_LIMITED_TECHNICAL_PILOT',
  verifier_sha256: sha(await readFile(new URL('./verify-feeds.mjs', import.meta.url))) };
await writeFile(new URL('results/b2-live-verification.json', root), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
