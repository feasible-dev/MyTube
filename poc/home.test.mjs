import { homeVideo } from './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHome, cleanHome, loadHome, rememberHome, homePicks, homeTopics, cachedSearchPicks, pastSearchPicks, mergeHomeRefresh } from './home.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';
const now = Date.parse('2026-11-07T12:00:00Z'), day = 86400000;
const video = (id, date = '2026-11-01') => ({ video_id: id, title: 'Navigation history', channel: `Channel ${id}`,
  description: 'A documentary', published_at: date, duration_seconds: 1800, views: 100, cachedAt: now, source: 'youtube_live' });
const topic = (label, videos) => ({ label, queries: [label + ' history'], subjects: [label], preferences: defaultPreferences(), uses: 1, updatedAt: now, videos });

test('home refresh preserves saved picks, interleaves arrivals and keeps existing batch limits', () => {
  const previous = Array.from({ length: 40 }, (_, i) => Object.freeze({ ...video(`old${i}`), cachedAt: now - 1000 }));
  const incoming = [video('old39'), ...Array.from({ length: 24 }, (_, i) => video(`new${i}`))];
  const merged = mergeHomeRefresh(previous, incoming, new Set(['old39']), now);
  assert.equal(merged.length, 40);
  assert.equal(merged[0], previous[39]);
  assert.deepEqual(merged.slice(0, 5).map(v => v.video_id), ['old39', 'old0', 'new0', 'old1', 'new1']);
  assert.equal(merged.filter(v => v.video_id === 'old39').length, 1);
  assert.ok(!merged.some(v => v.video_id === 'new19'));
  assert.equal(merged.find(v => v.video_id === 'new0').cachedAt, now);
  assert.equal(previous[0].cachedAt, now - 1000);
  assert.equal(incoming.length, 25);
});
test('web history retains sourced durations without refreshing metadata expiry', () => {
  const enriched = { ...video('aaaaaaaaaaa'), source: 'youtube_web', published_at: null, duration_seconds: 2700, duration_source: 'youtube_api', cachedAt: now - day };
  const home = cleanHome({ ...emptyHome(), topics: [topic('History', [enriched, { ...enriched, video_id: 'bbbbbbbbbbb', duration_source: 'guess' }])] }, now);
  assert.equal(home.topics[0].videos.length, 1);
  assert.equal(home.topics[0].videos[0].duration_seconds, 2700);
  assert.equal(home.topics[0].videos[0].cachedAt, now - day);
});

test('past searches balance newest searches first, ignoring upload age and hiding duplicates', () => {
  const home = { ...emptyHome(), hidden: ['ccccccccccc'], topics: [
    { ...topic('Older search', [video('aaaaaaaaaaa'), video('ddddddddddd')]), updatedAt: now - day, uses: 99 },
    topic('Newest search', [video('bbbbbbbbbbb', '2000-01-01'), video('aaaaaaaaaaa'), video('ccccccccccc')]),
  ] };
  assert.deepEqual(pastSearchPicks(home, now).map(v => v.video_id), ['bbbbbbbbbbb', 'aaaaaaaaaaa', 'ddddddddddd']);
});

test('home cache keeps valid column provenance for the next search transition', () => {
  const home = cleanHome({ ...emptyHome(), topics: [topic('History', [
    { ...video('aaaaaaaaaaa'), discovery_stream: 'wildcard' },
    { ...video('bbbbbbbbbbb'), discovery_stream: 'untrusted' },
  ])] }, now);
  assert.equal(home.topics[0].videos[0].discovery_stream, 'wildcard');
  assert.equal(home.topics[0].videos[1].discovery_stream, undefined);
});

test('cached search checks each video independently and rejected quick hits cannot teach the home', () => {
  const unrelated = { ...video('aaaaaaaaaaa'), title: 'Rickshaw action movie' };
  const relevant = { ...video('bbbbbbbbbbb'), title: 'Maya civilization' };
  const home = { ...emptyHome(), topics: [topic('Mayas', [unrelated, relevant])] };
  assert.deepEqual(cachedSearchPicks(home, 'Mayas', now).map(v => v.video_id), ['bbbbbbbbbbb']);
  const result = { query: 'Mayas', quick_query: 'Mayas', provisional_source: 'youtube', preferences: defaultPreferences(), videos: [unrelated, relevant] };
  assert.deepEqual(rememberHome(emptyHome(), result, now).topics[0].videos.map(v => v.video_id), ['bbbbbbbbbbb']);
});

test('home separates recent uploads and lasting discoveries, balances interests and respects hidden and saved picks', () => {
  const home = { ...emptyHome(), topics: [topic('Navigation', [video('aaaaaaaaaaa'), video('bbbbbbbbbbb', '2020-01-01')]), topic('Cinema', [video('ccccccccccc')])], hidden: ['aaaaaaaaaaa'], saved: ['bbbbbbbbbbb'] };
  const picks = homePicks(home, now);
  assert.deepEqual(picks.recent.map(v => v.video_id), ['ccccccccccc']);
  assert.deepEqual(picks.lasting.map(v => v.video_id), ['bbbbbbbbbbb']);
  assert.equal(picks.saved.length, 1);
  assert.equal(homeTopics(home)[0].label, 'Navigation');
});
test('cache sanitizes stored metadata, expires it at 30 days, and never persists credentials or arbitrary image URLs', () => {
  const home = { ...emptyHome(), topics: [topic('History', [{ ...video('aaaaaaaaaaa'), cachedAt: now - 30 * day },
    { ...video('bbbbbbbbbbb'), access_token: 'SECRET_CANARY', channel_avatar: 'https://evil.example/image' }, video('invalid')])] };
  const clean = cleanHome(home, now);
  assert.equal(clean.topics[0].videos.length, 1);
  assert.ok(!JSON.stringify(clean).includes('SECRET_CANARY'));
  assert.ok(!JSON.stringify(clean).includes('evil.example'));
  assert.equal(homePicks(clean, now + 30 * day).recent.length, 0);
  assert.equal(homePicks(clean, now + 30 * day).lasting.length, 0);
});
test('corrupt or unavailable storage cannot break discovery; disabled storage forgets the profile', () => {
  assert.deepEqual(loadHome({ getItem: () => '{broken', setItem: () => {} }, now), emptyHome());
  assert.deepEqual(loadHome({ getItem: () => { throw Error(); } }, now), emptyHome());
  const disabled = cleanHome({ ...emptyHome(), enabled: false, topics: [topic('History', [video('aaaaaaaaaaa')])], saved: ['aaaaaaaaaaa'] }, now);
  assert.equal(disabled.enabled, false); assert.equal(disabled.topics.length, 0); assert.equal(disabled.saved.length, 0);
});
test('searches teach the home concise topics without retaining the original dictation or resetting old metadata expiry', () => {
  const result = { query: 'PRIVATE_DICTATION_CANARY', preferences: defaultPreferences(), videos: [video('aaaaaaaaaaa')],
    streams: { direct: { subjects: ['Navigation'], searches: [{ query: 'Navigation history', status: 'complete' }] } } };
  let home = rememberHome(emptyHome(), result, now);
  home = rememberHome(home, { ...result, videos: [video('bbbbbbbbbbb')] }, now + day);
  assert.equal(home.topics[0].uses, 2);
  assert.equal(home.topics[0].videos.find(v => v.video_id === 'aaaaaaaaaaa').cachedAt, now);
  assert.ok(!JSON.stringify(home).includes('PRIVATE_DICTATION_CANARY'));
  assert.equal(rememberHome({ ...emptyHome(), enabled: false }, result, now).topics.length, 0);
});

test('external preview images survive cache cleaning only on the platform image hosts', () => {
  const now = Date.now();
  const v = { video_id: 'web:https://vimeo.com/123', source_url: 'https://vimeo.com/123', platform: 'Vimeo',
    source: 'external_web', title: 'Film discussion', channel: 'Vimeo', cachedAt: now,
    duration_seconds: null, published_at: null, views: null, thumbnail_url: 'https://i.vimeocdn.com/video/123.jpg' };
  assert.equal(homeVideo(v, now).thumbnail_url, v.thumbnail_url);
  assert.equal(homeVideo({ ...v, thumbnail_url: 'https://evil.example/a' }, now).thumbnail_url, undefined);
});
