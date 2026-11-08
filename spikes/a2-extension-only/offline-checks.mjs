/** A2 offline evidence only: documented URI shapes and synthetic local ranking.
 * No browser extension, provider requests, credentials, or real video data.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const fixtures = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));

function matchesDocumentedOssCallback(value) {
  const url = new URL(value);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && url.pathname === '/auth/callback' && !url.username && !url.password
    && !url.search && !url.hash;
}

const callbackCases = [
  { kind: 'local_listener', uri: 'http://127.0.0.1:1455/auth/callback', expected: true },
  { kind: 'local_listener_alternate_port', uri: 'http://127.0.0.1:54321/auth/callback', expected: true },
  { kind: 'chromium_identity', uri: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/auth/callback', expected: false },
  { kind: 'firefox_identity_loopback', uri: 'http://127.0.0.1/mozoauth2/example-subdomain', expected: false },
  { kind: 'localhost_substitution', uri: 'http://localhost:1455/auth/callback', expected: false },
];
const callbackResults = callbackCases.map(({ expected, ...entry }) => {
  const matches = matchesDocumentedOssCallback(entry.uri);
  assert.equal(matches, expected);
  return { ...entry, matches_documented_openai_uri_shape: matches };
});

function rank(intent, candidates) {
  const seen = new Set();
  return candidates.filter(item => {
    if (seen.has(item.fixture_id)) return false;
    seen.add(item.fixture_id);
    return item.is_short === false && Number.isFinite(item.duration_minutes)
      && item.duration_minutes >= intent.min_minutes && item.duration_minutes <= intent.max_minutes;
  }).map(item => {
    const words = new Set(`${item.title} ${item.description}`.toLowerCase().match(/[a-z]+/g) ?? []);
    return {
      fixture_id: item.fixture_id,
      matched_terms: intent.terms.filter(term => words.has(term)),
      duration_minutes: item.duration_minutes,
    };
  }).filter(item => item.matched_terms.length > 0)
    .sort((a, b) => b.matched_terms.length - a.matched_terms.length
      || (a.fixture_id < b.fixture_id ? -1 : a.fixture_id > b.fixture_id ? 1 : 0))
    .slice(0, 10);
}

const rankingResults = fixtures.intents.map(intent => {
  const ranked = rank(intent, fixtures.candidates);
  assert.deepEqual(ranked.map(item => item.fixture_id), intent.expected_ids);
  assert.deepEqual(rank(intent, [...fixtures.candidates].reverse()), ranked);
  assert.deepEqual(rank(intent, [...fixtures.candidates, ...fixtures.candidates]), ranked);
  assert.deepEqual(rank(intent, []), []);
  return { intent_id: intent.id, results: ranked, invariants_passed: ['expected_fixture_order', 'input_order_independence', 'duplicate_removal', 'empty_input'] };
});

const sourceHashes = {};
for (const name of ['offline-checks.mjs', 'fixtures.json']) {
  sourceHashes[name] = createHash('sha256').update(await readFile(new URL(`./${name}`, import.meta.url))).digest('hex');
}
const evidence = {
  spike: 'A2', recorded_at: new Date().toISOString(), status: 'OFFLINE_CHECKS_PASSED',
  scope: 'Document-contract comparison and synthetic local-ranking smoke test; NOT provider/browser validation or B1 quality evidence.',
  network_requests: 0, oauth_attempts: 0, inference_requests: 0,
  browser_extension_built: false, live_redirect_acceptance_tested: false,
  documented_uri_examples: callbackResults,
  synthetic_candidate_count: fixtures.candidates.length,
  ranking_results: rankingResults,
  source_sha256: sourceHashes,
};
await writeFile(new URL('../../results/a2-offline-checks.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
