import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { estimateSearch, estimateChannels, capacity, documentedLimits } from './model.mjs';
const root = new URL('../../', import.meta.url);
const run = JSON.parse(await readFile(new URL('results/b1-run-1794078880207-7c695f76-0cf1-4fcd-9bf2-bb8aa9416367.json', root), 'utf8'));
assert.equal(run.requests.filter(r => r.endpoint === 'search').length, 12);
assert.equal(run.requests.filter(r => r.endpoint === 'videos').length, 6);
const scenarios = [];
for (const users of [5, 10, 20]) {
  for (const intentionsPerDay of [1, 3, 5]) scenarios.push({ kind: 'uncached_search', users, intentions_per_user_per_day: intentionsPerDay,
    ...capacity(estimateSearch({ users, intentionsPerDay })) });
  scenarios.push({ kind: 'hypothetical_cold_channel_refresh', users, channels_per_user: 20, refreshes_per_day: 1,
    ...capacity(estimateChannels({ users, channelsPerUser: 20 })) });
  scenarios.push({ kind: 'hypothetical_warm_channel_refresh', users, channels_per_user: 20, refreshes_per_day: 1,
    assumed_new_videos_per_channel: 2, ...capacity(estimateChannels({ users, channelsPerUser: 20, metadataVideosPerChannel: 2, cachedChannelIds: true })) });
}
const source_sha256 = {};
for (const name of ['model.mjs', 'check.mjs', 'public-feed.mjs', 'b2.test.mjs', 'sample.mjs']) source_sha256[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
const evidence = { spike: 'B2', recorded_at: new Date().toISOString(), status: 'DOCS_AND_OFFLINE_MODEL_COMPLETE',
  verdict: 'CONDITIONAL_GO_FOR_LIMITED_TECHNICAL_PILOT', network_requests: 0, oauth_attempts: 0,
  documented_daily_limits: documentedLimits, project_limits_verified: false, reserve_fraction_assumed: 0.2,
  measured_b1_requests: { search: 12, metadata: 6, themes: 3 },
  public_feed_live_test_completed: false, google_oauth_live_test_completed: false,
  end_user_installation_validated: false, source_sha256, scenarios };
await writeFile(new URL('results/b2-capacity.json', root), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
