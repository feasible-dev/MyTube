// Historical local-catalog search; not used by the current discovery UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalog, queryTerms, escapeEmbeddedJson, visibleRows, replacementColumn, selectDiscoveryRows, filterLiveResults } from './model.mjs';

const videos = [
  { video_id: 'a', title: 'Disaster investigation documentary', channel: 'Daily Creator', duration_seconds: 1800 },
  { video_id: 'b', title: 'Engineering seminar', channel: 'Example University', duration_seconds: 3000 },
  { video_id: 'c', title: 'Full trial proceedings', channel: 'Public Record', duration_seconds: 4000 },
  { video_id: 'd', title: 'A conference lecture', channel: 'Independent Lecturer', duration_seconds: 2400 },
];
const state = { search: '', duration: 'all', method: 'diversified', preferInstitutions: true,
  savedOnly: false, saved: new Set(), hidden: new Set() };

test('new queries search the catalog, require all keywords, and handle common topic variants', () => {
  const catalog = [
    { ...videos[0], title: 'Mathematical proofs', description: 'An introduction to sets' },
    { ...videos[1], title: 'Sets', description: 'A rigorous mathematics proof' },
    { ...videos[2], title: 'Historical sources', description: 'How to research history' },
  ];
  assert.deepEqual(queryTerms('Show me some math proofs please'), ['mathematics', 'proof']);
  assert.deepEqual(searchCatalog(catalog, 'math proofs', state).map(v => v.video_id), ['a', 'b']);
  assert.deepEqual(searchCatalog(catalog, 'history', state).map(v => v.video_id), ['c']);
  assert.deepEqual(searchCatalog(catalog, 'mathematics history', state), []);
  assert.deepEqual(searchCatalog(catalog, 'and the', state), []);
  assert.deepEqual(searchCatalog(catalog, 'math', { ...state, hidden: new Set(['a']), savedOnly: true, saved: new Set(['a']) }), []);
  assert.equal(catalog[0].match_terms, undefined);
});

test('queries are bounded text, never regular expressions or executable markup', () => {
  assert.throws(() => queryTerms('a'.repeat(301)), /INVALID_QUERY/);
  assert.throws(() => queryTerms(null), /INVALID_QUERY/);
  assert.deepEqual(searchCatalog(videos, '[.*+?]', state), []);
  const hostile = '</script><img src=x onerror=alert(1)>';
  assert.ok(!escapeEmbeddedJson({ query: hostile }).includes('<'));
  assert.deepEqual(searchCatalog(videos, hostile, state), []);
});

const snapshot = { rankings: Object.fromEntries(['diversified', 'search_baseline'].map(m =>
  [m, { direct: videos, adjacent: [], wildcard: [] }])) };

test('legacy ranking boosts sources without dropping records or changing evidence', () => {
  assert.deepEqual(visibleRows(snapshot, state).direct.map(v => v.video_id), ['b', 'c', 'd', 'a']);
  assert.deepEqual(videos.map(v => v.video_id), ['a', 'b', 'c', 'd']);
  for (const extra of [{ preferInstitutions: false }, { method: 'search_baseline' }]) {
    assert.deepEqual(visibleRows(snapshot, { ...state, ...extra }).direct, videos);
  }
  assert.deepEqual(visibleRows(snapshot, { ...state, search: 'UNIVERSITY' }).direct.map(v => v.video_id), ['b']);
  assert.deepEqual(visibleRows(snapshot, { ...state, duration: 'long' }).direct.map(v => v.video_id), ['b', 'd']);
  assert.deepEqual(visibleRows(snapshot, { ...state, savedOnly: true, saved: new Set(['b', 'c']), hidden: new Set(['b']) }).direct.map(v => v.video_id), ['c']);
});

test('legacy arrivals replace slots top-down without duplicates across columns', () => {
  const previous = ['old1', 'old2', 'old3', 'old4'].map(video_id => ({ video_id }));
  const fresh = ['new1', 'new2'].map(video_id => ({ video_id }));
  assert.deepEqual(replacementColumn([], previous, []).map(s => s.video.video_id), ['old1', 'old2', 'old3', 'old4']);
  assert.deepEqual(replacementColumn(fresh.slice(0, 1), previous, ['new1']).map(s => s.video.video_id), ['new1', 'old2', 'old3', 'old4']);
  const slots = replacementColumn(fresh, previous, ['new1', 'new2', 'old4']);
  assert.deepEqual(slots.map(s => s.video.video_id), ['new1', 'new2', 'old3']);
  assert.deepEqual(slots.map(s => s.previous), [false, false, true]);
  assert.equal(replacementColumn(fresh, previous, [], 1).length, 1);
  assert.equal(previous[0].video_id, 'old1');
});

const angleVideos = (angle, count = 12, stream = 'wildcard') => Array.from({ length: count }, (_, i) => ({
  video_id: `${angle}-${i}`, title: `${angle} subject ${i}`, channel: `${angle} source ${i}`,
  discovery_stream: stream, discovery_query: angle, duration_seconds: 2400, provider_rank: i,
}));

test('legacy discovery balances angles despite source boosts and shares spare slots', () => {
  const pools = ['ecology', 'cooperation', 'networks', 'writing'].flatMap(angle => angleVideos(angle));
  for (const v of pools.filter(v => v.discovery_query === 'ecology')) v.channel = `University ${v.video_id}`;
  const ranked = filterLiveResults(pools, state), before = JSON.stringify(ranked);
  const rows = selectDiscoveryRows(ranked, 'wildcard');
  assert.equal(rows.length, 12);
  for (const angle of ['ecology', 'cooperation', 'networks', 'writing']) assert.equal(rows.filter(v => v.discovery_query === angle).length, 3);
  assert.equal(new Set(rows.slice(0, 4).map(v => v.discovery_query)).size, 4);
  assert.equal(JSON.stringify(ranked), before);
  const uneven = [...angleVideos('one', 1), ...angleVideos('two'), ...angleVideos('three'), ...angleVideos('four')];
  const shared = selectDiscoveryRows(filterLiveResults(uneven, state), 'wildcard');
  assert.equal(shared.length, 12);
  assert.equal(shared.filter(v => v.discovery_query === 'one').length, 1);
  for (const angle of ['two', 'three', 'four']) assert.ok(shared.filter(v => v.discovery_query === angle).length <= 4);
  const filtered = selectDiscoveryRows(filterLiveResults(uneven, { ...state, hidden: new Set(['one-0']), search: 'two' }), 'wildcard');
  assert.equal(filtered.length, 4);
  assert.ok(filtered.every(v => v.discovery_query === 'two'));
});

test('legacy angle, channel and title caps prevent padding a discovery column', () => {
  assert.equal(selectDiscoveryRows(angleVideos('business'), 'wildcard').length, 4);
  assert.equal(selectDiscoveryRows(angleVideos('empire', 12, 'adjacent'), 'adjacent').length, 4);
  assert.equal(selectDiscoveryRows(angleVideos('rome', 12, 'direct'), 'direct').length, 12);
  const rows = angleVideos('ecology');
  rows.forEach(v => { v.channel = 'Same Channel'; });
  assert.equal(selectDiscoveryRows(rows, 'wildcard').length, 2);
  const copies = [angleVideos('one')[0], angleVideos('two')[0]];
  copies[0].title = 'A shared film!'; copies[1].title = 'A SHARED film';
  assert.equal(selectDiscoveryRows(copies, 'wildcard').length, 1);
});
