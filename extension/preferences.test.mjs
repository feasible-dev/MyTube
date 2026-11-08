import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, validatePreferences, LANGUAGE_CHOICES, languageMatches } from './preferences.mjs';
import { createIntentionTask, validateCompactPlan } from '../connector/task.mjs';
import { MODEL } from '../spikes/a3-query-generation/core.mjs';
import { validateDiscoveryPlan, discoverVideos } from './discovery.mjs';
import { matchesDirectSubject } from './direct-relevance.mjs';
import { filterLiveResults } from '../poc/model.mjs';

test('older saved preferences gain originality without losing existing choices', () => {
  const older = { ...defaultPreferences(), depth: 85, languages: ['fr'] }; delete older.originality;
  const updated = validatePreferences(older);
  assert.equal(updated.originality, 50); assert.equal(updated.depth, 75); assert.deepEqual(updated.languages, ['fr']);
  assert.equal(older.originality, undefined);
  for (const originality of [-1, 101, '40']) assert.throws(() => validatePreferences({ ...older, originality }), /INVALID_PREFERENCES/);
});

test('preferences are bounded, explicit and independently copied; unknown keys never enter the prompt', () => {
  const defaults = defaultPreferences();
  assert.equal(defaults.politics, 50); assert.deepEqual(defaults.languages, ['en']);
  const copy = validatePreferences(defaults); copy.languages.push('fr');
  assert.deepEqual(defaults.languages, ['en']);
  for (const value of [null, [], { ...defaults, prompt: 'override' }, { ...defaults, depth: '100' },
    { ...defaults, politics: 101 }, { ...defaults, audience: -1 }, { ...defaults, minMinutes: 0 },
    { ...defaults, minMinutes: 121 }, { ...defaults, maxMinutes: 361 }, { ...defaults, languages: [] },
    { ...defaults, languages: ['en', 'en'] }, { ...defaults, languages: ['https://example.com'] }]) {
    assert.throws(() => validatePreferences(value), /INVALID_PREFERENCES/);
  }
  assert.equal(new Set(LANGUAGE_CHOICES.map(l => l.code)).size, LANGUAGE_CHOICES.length);
  assert.ok(languageMatches('fr-CA', ['fr'])); assert.ok(languageMatches(undefined, ['en']));
  assert.equal(languageMatches('hi', ['en', 'fr']), false);
});

test('editorial axes enter the planner independently without altering the original request', () => {
  const preferences = { ...defaultPreferences(), origin: 100, audience: 0, depth: 90, perspective: 100, politics: 0, languages: ['fr', 'en'] };
  const intention = 'Investigations of the Kennedy assassination';
  const request = createIntentionTask(intention, () => {}, preferences).build(MODEL);
  assert.equal(request.input[0].content, intention);
  assert.ok(request.instructions.includes(JSON.stringify(validatePreferences(preferences))));
  assert.match(request.instructions, /do not replace it with debunking, ridicule/);
  assert.match(request.instructions, /do not politicize unrelated topics/);
  assert.match(request.instructions, /Preserve the DIRECT subject/);
  assert.match(request.instructions, /not the user's gender/);
});

test('maximum normal multilingual intention and full language selection fit the existing inference byte limit', () => {
  const intention = 'x'.repeat(4000) + 'é'.repeat(2000);
  for (const recovery of [undefined, 'NO_RESULTS', 'OFF_TOPIC_SEARCH_PLAN']) {
    const request = createIntentionTask(intention, () => {}, { ...defaultPreferences(), languages: LANGUAGE_CHOICES.map(l => l.code) }, recovery).build(MODEL);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 16384);
  }
});

test('age and popularity affect candidate order independently and neutral settings preserve relevance', () => {
  const rows = [
    { video_id: 'a', title: 'Modern film essay', channel: 'A', duration_seconds: 1800, provider_rank: 1, published_at: '2025-01-01', views: 500000 },
    { video_id: 'b', title: 'Archive film essay', channel: 'B', duration_seconds: 1800, provider_rank: 2, published_at: '2010-01-01', views: 120 },
    { video_id: 'c', title: 'Unknown metadata', channel: 'C', duration_seconds: 1800, provider_rank: 3, views: null },
  ];
  const rank = overrides => filterLiveResults(rows, { minMinutes: 20, maxMinutes: 120, search: '', hidden: new Set(), saved: new Set(), liveResult: { preferences: { ...defaultPreferences(), ...overrides } } }).map(v => v.video_id);
  assert.deepEqual(rank({}), ['a', 'b', 'c']);
  assert.equal(rank({ popularity: 0 })[0], 'b');
  assert.equal(rank({ popularity: 100 })[0], 'a');
  assert.equal(rank({ recency: 0 })[0], 'b');
  assert.equal(rank({ recency: 100 })[0], 'a');
});

test('non-Latin queries preserve direct subject anchors through both validation boundaries', () => {
  const compact = { direct_subjects: ['古代罗马'], ...Object.fromEntries(['direct', 'adjacent', 'wildcard'].map((stream, i) => [stream, {
    queries: [1, 2, 3, 4].map(n => `${i === 0 ? '古代罗马' : '不同历史'}文化交流历史讲座 ${i} ${n}`), why: 'Independent angles on historical institutions',
  }])) };
  validateCompactPlan(compact);
  validateDiscoveryPlan({ direct_subjects: compact.direct_subjects, queries: ['direct', 'adjacent', 'wildcard'].flatMap(stream => compact[stream].queries.map(query => ({ stream, query, why: compact[stream].why }))) });
  assert.ok(matchesDirectSubject({ title: '关于古代罗马的讲座' }, '', compact.direct_subjects));
  assert.equal(matchesDirectSubject({ title: 'Unrelated modern television' }, '', compact.direct_subjects), false);
});

test('discovery forwards preferences and targets selected languages without increasing its twelve-query budget', async () => {
  const preferences = { ...defaultPreferences(), minMinutes: 1, maxMinutes: 360, languages: ['fr', 'en'], perspective: 100, politics: 80 };
  const queries = ['direct', 'adjacent', 'wildcard'].flatMap(stream => [1, 2, 3, 4].map(i => ({ stream, query: `${stream} history lecture ${i}`, why: 'A synthetic connection for tests' })));
  let planner = 0, google = 0;
  const result = await discoverVideos({ intention: 'Historical institutions', preferences, getToken: async () => 'TEST_TOKEN_ONLY_123456789',
    fetchImpl: async (url, options) => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') {
        planner++; assert.deepEqual(JSON.parse(options.body).preferences, validatePreferences(preferences));
        return new Response(JSON.stringify({ queries }), { headers: { 'content-type': 'application/json' } });
      }
      google++;
      const i = queries.findIndex(q => q.query === u.searchParams.get('q'));
      assert.equal(u.searchParams.get('relevanceLanguage'), preferences.languages[i % 2]);
      assert.equal(u.searchParams.has('videoDuration'), false);
      return new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
    } });
  assert.equal(planner, 2); assert.equal(google, 12, 'An empty search may replan, but identical queries are not sent twice');
  assert.deepEqual(result.preferences, validatePreferences(preferences));
});
