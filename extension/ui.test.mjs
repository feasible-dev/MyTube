import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences } from './preferences.mjs';
import { loadCurrentPage as loadPage } from './ui-harness.mjs';

test('home opens with archived recommendations, keeps the last search accessible, and subscriptions require an explicit connection', async () => {
  const now = Date.parse('2026-11-07T23:00:00Z'), data = new Map();
  const video = { video_id: 'abcdefghijk', title: 'Ocean history', channel: 'Museum', source: 'youtube_live', published_at: '2026-11-01', duration_seconds: 1800, cachedAt: now };
  data.set('mytube.search-archive.v1', JSON.stringify([{ id: 'older', at: now, query: 'Pacific voyages', videos: [video], count: 1 }]));
  const { document, start } = await loadPage({ storage: { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) } });
  start();
  for (let i = 0; i < 30 && !document.querySelector('#streams .video-card'); i++) await new Promise(setImmediate);
  assert.equal(document.getElementById('current-topic').textContent, 'For you');
  assert.equal(document.querySelector('#streams .video-card')?.getAttribute('data-video-id'), video.video_id);
  document.getElementById('subscriptions-tab').click();
  assert.match(document.getElementById('streams').textContent, /Connect YouTube/);
  assert.equal(document.querySelector('#streams .video-card'), null);
  document.getElementById('home-tab').click();
  assert.equal(document.querySelector('#streams .video-card')?.getAttribute('data-video-id'), video.video_id);
  document.getElementById('clear-home').click(); document.getElementById('confirm-forget-history').click();
  await new Promise(setImmediate);
  assert.equal(data.get('mytube.search-archive.v1'), '[]');
  assert.equal(document.querySelector('#streams .video-card'), null);
});

test('scrolling reveals received overflow without more searches; a new topic resets the page size', async () => {
  let intersect, calls = 0;
  const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  class Observer {
    constructor(callback) { intersect = callback; }
    observe() {}
    disconnect() {}
  }
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const { document, window, start } = await loadPage({ web: true, storage, preflight: true, localKey: true, observer: Observer,
    windows: { create: async () => assert.fail('Already connected') },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/authorization')) return json({ authorization_url: null });
      if (url.endsWith('/connect')) return json({ connected: true });
      if (url.endsWith('/plan')) return json({ queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream, query: `${stream} archaeology`, why: 'History connection' })) });
      if (url.endsWith('/wildcard-discover')) return json({ videos: [], searches: 1 });
      assert.ok(url.endsWith('/youtube/search')); calls++;
      const isDirect = JSON.parse(init.body).query === 'Maya';
      const isWildcard = JSON.parse(init.body).query.startsWith('wildcard');
      return json({ requests: 2, search_results: 20, videos: Array.from({ length: 20 }, (_, i) => ({
        video_id: String((isDirect ? 0 : isWildcard ? 200 : 100) + i).padStart(11, '0'), title: `Maya archaeology ${isDirect ? 'direct' : isWildcard ? 'exploration' : 'related'} ${i}`,
        channel: `Museum ${i}`, source: 'youtube_live', duration_seconds: 1800, published_at: '2024-01-01', views: 100,
      })) });
    } });
  const settle = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate); assert.ok(predicate()); };
  start(); document.getElementById('new-search').click();
  await settle(() => document.getElementById('query-dialog').hasAttribute('open'));
  document.getElementById('query-input').value = 'Maya';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle(() => calls === 3 && document.getElementById('streams').getAttribute('aria-busy') === 'false');
  assert.equal(document.querySelectorAll('.direct .video-card').length, 8);
  window.scrollY = 500; intersect([{ isIntersecting: true }]);
  assert.equal(document.querySelectorAll('.direct .video-card').length, 16);
  assert.equal(document.querySelectorAll('.related .video-card').length, 16);
  document.querySelector('.more-results').click();
  assert.equal(document.querySelectorAll('.direct .video-card').length, 20);
  assert.equal(document.querySelector('.more-results'), null); assert.equal(calls, 3);
  const reopened = await loadPage({ web: true, storage }); reopened.start(); reopened.document.getElementById('search-tab').click();
  assert.equal(reopened.document.querySelectorAll('.direct .video-card').length, 20);
  assert.equal(reopened.document.querySelectorAll('.related .video-card').length, 20);
  assert.equal(reopened.document.getElementById('current-topic').title, 'Maya');
  assert.equal(reopened.document.querySelector('.loading-spinner'), null);
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle(() => calls === 6 && document.getElementById('streams').getAttribute('aria-busy') === 'false');
  assert.equal(document.querySelectorAll('.direct .video-card').length, 8);
});

test('reopening restores all three partial columns without login or rerunning search, and clear removes the snapshot', async () => {
  const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  let controller;
  const first = await loadPage({ web: true, storage, fetchImpl: async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'application/x-ndjson' } }) });
  const rows = ['direct', 'adjacent', 'wildcard'].map((discovery_stream, i) => ({
    video_id: String(i).padStart(11, '0'), title: `History ${i}`, channel: `Museum ${i}`, source: 'youtube_web',
    source_url: `https://www.youtube.com/watch?v=${String(i).padStart(11, '0')}`, duration_seconds: null,
    published_at: null, views: null, discovery_stream, discovery_why: 'History connection',
  }));
  const settle = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate); assert.ok(predicate()); };
  first.start(); first.document.getElementById('query-input').value = 'Conversos around the world';
  first.document.getElementById('query-form').dispatchEvent(new first.window.Event('submit', { cancelable: true }));
  try {
    await settle(() => Boolean(controller));
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'progress', videos: rows, searches: 2 }) + '\n'));
    await settle(() => first.document.querySelectorAll('#streams .video-card').length === 3);
    const reopened = await loadPage({ web: true, storage }); reopened.start(); reopened.document.getElementById('search-tab').click();
    for (const column of ['direct', 'related', 'wildcard']) assert.equal(reopened.document.querySelectorAll(`.${column} .video-card`).length, 1);
    assert.equal(reopened.document.getElementById('current-topic').title, 'Conversos around the world');
    assert.equal(reopened.document.getElementById('streams').getAttribute('aria-busy'), 'false');
    assert.match(reopened.document.getElementById('status').textContent, /interrupted/);
    reopened.document.getElementById('clear-home').click(); reopened.document.getElementById('confirm-forget-history').click();
    assert.equal(data.get('mytube.last-search.v1'), 'null');
    const cleared = await loadPage({ web: true, storage }); cleared.start();
    assert.equal(cleared.document.querySelectorAll('#streams .video-card').length, 0);
  } finally {
    first.document.querySelector('.search-progress button')?.click(); controller?.close();
  }
});

test('a completed empty related column does not claim to be searching while jokers are pending', async () => {
  let release, calls = 0;
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const { document, window, start } = await loadPage({ web: true, preflight: true, localKey: true,
    windows: { create: async () => assert.fail('Already connected') }, fetchImpl: async url => {
      if (url.endsWith('/authorization')) return json({ authorization_url: null });
      if (url.endsWith('/connect')) return json({ connected: true });
      if (url.endsWith('/plan')) return json({ queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream, query: `${stream} archaeology`, why: 'History connection' })) });
      if (url.endsWith('/wildcard-discover')) return new Promise(resolve => { release = () => resolve(json({ videos: [], searches: 1 })); });
      calls++;
      return json({ requests: 1, search_results: calls === 1 ? 1 : 0, videos: calls === 1 ? [{ video_id: 'abcdefghijk', title: 'Maya archaeology', channel: 'Museum',
        source: 'youtube_live', duration_seconds: 1800, published_at: '2024-01-01', views: 10 }] : [] });
    } });
  const settle = async test => { for (let i = 0; i < 100 && !test(); i++) await new Promise(setImmediate); assert.ok(test()); };
  start(); document.getElementById('new-search').click(); await settle(() => document.getElementById('query-dialog').hasAttribute('open'));
  document.getElementById('query-input').value = 'Maya archaeology'; document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  try {
    await settle(() => Boolean(release) && /No additional videos/.test(document.querySelector('.related').textContent));
    assert.equal(document.querySelector('.related .loading-spinner'), null);
    assert.ok(document.querySelector('.wildcard .loading-spinner'));
    assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelector('.why'), null);
    assert.equal(document.querySelector('.card-details .ban-channel').textContent, 'Ban channel');
  } finally { release?.(); await settle(() => document.getElementById('streams').getAttribute('aria-busy') === 'false'); }
});

test('five labeled levels and blocked channels persist independently of history and filter later batches', async () => {
  const now = Date.parse('2026-11-07T23:00:00Z'), data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const video = (id, channel) => ({ video_id: id, channel, title: `Maya ${channel}`, source: 'youtube_web',
    source_url: `https://www.youtube.com/watch?v=${id}`, discovery_stream: 'direct', discovery_why: 'Maya archaeology', duration_seconds: null, published_at: null, views: null, cachedAt: now });
  data.set('mytube.home.v1', JSON.stringify({ version: 1, enabled: true, saved: [], hidden: [], topics: [{
    label: 'Maya', queries: ['Maya'], updatedAt: now, preferences: defaultPreferences(), videos: [video('abcdefghijk', 'Museum')],
  }] }));
  const first = await loadPage({ web: true, storage }); first.start();
  const slider = first.document.getElementById('pref-politics'); slider.value = '75'; slider.dispatchEvent(new first.window.Event('input'));
  assert.equal(first.document.querySelectorAll('.level-ticks span').length, 40);
  assert.equal(first.document.getElementById('pref-politics').getAttribute('aria-valuetext'), 'Center-right');
  assert.equal(first.document.getElementById('level-politics'), null);
  for (const slider of first.document.querySelectorAll('[id^=pref-]')) assert.equal(slider.getAttribute('step'), '25');
  assert.ok([...first.document.querySelectorAll('.level-ticks')].every(ticks => !ticks.textContent.trim()));
  first.document.getElementById('past-searches-button').click();
  first.document.querySelector('.ban-channel').click();
  assert.equal(first.document.querySelectorAll('#past-searches-videos .video-card').length, 0);
  first.document.getElementById('close-past-searches').click();
  first.document.getElementById('clear-home').click(); first.document.getElementById('confirm-forget-history').click();
  assert.equal(JSON.parse(data.get('mytube.blocked-channels')).channels[0].name, 'Museum');
  const second = await loadPage({ web: true, storage, fetchImpl: async () => new Response(JSON.stringify({ searches: 1,
    videos: [video('lmnopqrstuv', 'Museum'), video('12345678901', 'Archives')] }), { headers: { 'content-type': 'application/json' } }) }); second.start();
  assert.equal(second.document.getElementById('pref-politics').value, '75');
  second.document.getElementById('query-input').value = 'Maya';
  second.document.getElementById('query-form').dispatchEvent(new second.window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 100 && second.document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(setImmediate);
  assert.equal(second.document.querySelectorAll('#streams .video-card').length, 1);
  assert.equal(second.document.querySelector('#streams .channel-name').textContent, 'Archives');
  second.document.getElementById('blocked-channels-button').click();
  second.document.querySelector('#blocked-channels-list button').click();
  assert.equal(second.document.querySelectorAll('#streams .video-card').length, 2);
  assert.equal(JSON.parse(data.get('mytube.blocked-channels')).channels.length, 0);
});

test('style, duration and language choices reopen intact and survive clearing history', async () => {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const first = await loadPage({ web: true, storage }); first.start();
  const set = (id, value) => { const node = first.document.getElementById(id); node.value = value; node.dispatchEvent(new first.window.Event('input')); };
  set('pref-depth', '85'); set('pref-originality', '70'); set('min-duration', '10'); set('max-duration', '90');
  const french = first.document.querySelector('[data-language="fr"]'); french.checked = true; french.dispatchEvent(new first.window.Event('change'));
  first.document.getElementById('clear-home').click(); first.document.getElementById('confirm-forget-history').click();
  const second = await loadPage({ web: true, storage }); second.start();
  assert.equal(second.document.getElementById('pref-depth').value, '75');
  assert.equal(second.document.getElementById('pref-originality').value, '75');
  assert.equal(second.document.getElementById('min-duration').value, '10');
  assert.equal(second.document.getElementById('max-duration').value, '90');
  assert.equal(second.document.querySelector('[data-language="fr"]').checked, true);
  assert.equal(second.document.getElementById('video-language-value').textContent, '2 selected');
  second.document.getElementById('reset-preferences').click();
  const third = await loadPage({ web: true, storage }); third.start();
  assert.equal(third.document.getElementById('pref-depth').value, '50');
  assert.equal(third.document.getElementById('video-language-value').textContent, 'English');
});

test('cached tiles paint immediately and gain real durations silently in the background', async () => {
  const now = Date.parse('2026-11-07T23:00:00Z'); let authCalls = 0;
  let stored = JSON.stringify({ version: 1, enabled: true, refreshedAt: now, saved: [], hidden: [], topics: [{
    label: 'Navigation', queries: ['Navigation'], subjects: ['Navigation'], uses: 1, updatedAt: now, preferences: defaultPreferences(),
    videos: [{ video_id: 'abcdefghijk', title: 'Navigation history', channel: 'Museum', source: 'youtube_web', duration_seconds: null, published_at: null, cachedAt: now }],
  }] });
  const { document, start } = await loadPage({ web: true, durations: true,
    storage: { getItem: key => key === 'mytube.home.v1' ? stored : null, setItem: (key, value) => { if (key === 'mytube.home.v1') stored = value; } },
    getAuthToken: async options => { assert.equal(options.interactive, false); authCalls++; return { token: 'DURATION_TEST_TOKEN_123456', grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] }; },
    fetchImpl: async url => {
      assert.equal(new URL(url).pathname, '/youtube/v3/videos');
      return new Response(JSON.stringify({ items: [{ id: 'abcdefghijk', snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT45M' } }] }), { headers: { 'content-type': 'application/json' } });
    } });
  start(); document.getElementById('past-searches-button').click(); assert.equal(document.querySelectorAll('#past-searches-videos .video-card').length, 1);
  assert.equal(document.querySelector('.duration-badge'), null); assert.equal(authCalls, 0);
  for (let i = 0; i < 100 && !document.querySelector('.duration-badge'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(document.querySelector('.duration-badge')?.textContent, '45 min'); assert.equal(authCalls, 1);
  assert.equal(JSON.parse(stored).topics[0].videos[0].duration_seconds, 2700);
  assert.equal(JSON.parse(stored).topics[0].videos[0].cachedAt, now);
});

test('video languages stay on the main page while history controls live in settings', async () => {
  const { document, window, start } = await loadPage({ web: true }); start();
  assert.equal(document.getElementById('video-language-value').textContent, 'English');
  assert.equal(document.querySelector('#settings-dialog #language-options'), null);
  assert.equal(document.querySelector('#settings-dialog #clear-home'), null);
  document.getElementById('languages-button').click();
  assert.ok(document.getElementById('languages-dialog').hasAttribute('open'));
  assert.equal(document.querySelector('[data-language="en"]').checked, true);
  const french = document.querySelector('[data-language="fr"]'); french.checked = true;
  french.dispatchEvent(new window.Event('change'));
  assert.equal(document.getElementById('video-language-value').textContent, '2 selected');
  document.getElementById('done-languages').click();
  assert.equal(document.getElementById('languages-dialog').hasAttribute('open'), false);
  assert.equal(document.querySelector('.topbar #remember-interests'), null);
  assert.ok(document.querySelector('#settings-dialog #remember-interests'));
  assert.equal(document.querySelectorAll('#remember-interests').length, 1);
  assert.match(document.querySelector('.remember-history').textContent, /Remember past searches on this device/);
  document.getElementById('settings-button').click(); document.getElementById('history-button').click();
  assert.ok(document.getElementById('history-dialog').hasAttribute('open'));
  assert.equal(document.getElementById('settings-dialog').hasAttribute('open'), false);
  document.getElementById('done-history').click();
  assert.equal(document.getElementById('history-dialog').hasAttribute('open'), false);
});

test('history is disabled only after confirmation and restores its choice on reopening', async () => {
  let stored = null;
  const storage = { getItem: key => key === 'mytube.home.v1' ? stored : null, setItem: (key, value) => { if (key === 'mytube.home.v1') stored = value; } };
  const first = await loadPage({ web: true, storage }); first.start();
  const checkbox = first.document.getElementById('remember-interests');
  const before = stored;
  assert.equal(checkbox.checked, true);
  checkbox.checked = false; checkbox.dispatchEvent(new first.window.Event('change'));
  assert.equal(checkbox.checked, true);
  assert.equal(stored, before, 'No storage mutation before confirmation');
  assert.ok(first.document.getElementById('forget-history-dialog').hasAttribute('open'));
  first.document.getElementById('confirm-forget-history').click();
  assert.equal(JSON.parse(stored).enabled, false);
  const reopened = await loadPage({ web: true, storage }); reopened.start(); reopened.document.getElementById('search-tab').click();
  assert.equal(reopened.document.getElementById('remember-interests').checked, false);
  checkbox.checked = true; checkbox.dispatchEvent(new first.window.Event('change'));
  assert.equal(JSON.parse(stored).enabled, true);
});

test('New search opens the phrase dialog only after connecting, without sending a phrase or searching', async () => {
  let release, connections = 0;
  const { document, start } = await loadPage({ web: true, preflight: true,
    windows: { create: async () => assert.fail('Cached login should not show a popup') },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/authorization')) return new Response(JSON.stringify({ authorization_url: null }), { headers: { 'content-type': 'application/json' } });
      assert.ok(url.endsWith('/connect')); assert.equal(init.body, '{}');
      assert.ok(init.headers['X-MyTube-Request']); connections++;
      return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ connected: true }), { headers: { 'content-type': 'application/json' } })); });
    } });
  start(); assert.equal(connections, 0);
  document.getElementById('new-search').click();
  for (let i = 0; i < 20 && !connections; i++) await new Promise(setImmediate);
  assert.equal(connections, 1);
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), false);
  assert.equal(document.getElementById('connection-status').hidden, false);
  assert.equal(document.getElementById('query-input').disabled, true);
  assert.equal(document.getElementById('submit-query').disabled, true);
  document.getElementById('new-search').click(); assert.equal(connections, 1);
  release();
  for (let i = 0; i < 20 && document.getElementById('query-input').disabled; i++) await new Promise(setImmediate);
  assert.equal(document.getElementById('query-input').disabled, false);
  assert.equal(document.getElementById('submit-query').disabled, false);
  assert.equal(document.getElementById('query-help').hidden, true);
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), true);
  assert.equal(document.getElementById('connection-status').hidden, true);
});

test('failed connection stays on the main page and New search can retry', async () => {
  let attempts = 0;
  const { document, start } = await loadPage({ web: true, preflight: true, windows: { create: async () => ({ id: 1 }) },
    fetchImpl: async url => {
      if (url.endsWith('/authorization')) return new Response(JSON.stringify({ authorization_url: null }), { headers: { 'content-type': 'application/json' } });
      attempts++;
      return new Response(JSON.stringify(attempts === 1 ? { error: 'CHATGPT_SIGN_IN_REQUIRED' } : { connected: true }),
        { status: attempts === 1 ? 400 : 200, headers: { 'content-type': 'application/json' } });
    } });
  start(); document.getElementById('new-search').click();
  for (let i = 0; i < 20 && document.getElementById('new-search').disabled; i++) await new Promise(setImmediate);
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), false);
  assert.equal(document.getElementById('connection-status').hidden, false);
  assert.match(document.getElementById('connection-message').textContent, /ChatGPT/);
  assert.equal(document.getElementById('new-search').disabled, false);
  document.getElementById('new-search').click();
  for (let i = 0; i < 20 && document.getElementById('new-search').disabled; i++) await new Promise(setImmediate);
  assert.equal(attempts, 2);
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), true);
});

test('canceling connection prevents late completion from reopening or enabling a new search', async () => {
  let aborted = false;
  const { document, start } = await loadPage({ web: true, preflight: true, windows: { create: async () => ({ id: 1 }) },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/authorization')) return new Response(JSON.stringify({ authorization_url: null }), { headers: { 'content-type': 'application/json' } });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true }));
    } });
  start(); document.getElementById('new-search').click();
  await new Promise(setImmediate); document.getElementById('cancel-connection').click();
  await new Promise(setImmediate);
  assert.equal(aborted, true); assert.equal(document.getElementById('query-dialog').hasAttribute('open'), false);
  assert.equal(document.getElementById('new-search').disabled, false);
  assert.equal(document.querySelectorAll('.direct .video-card').length, 0);
});

test('personal home paints cached picks before any provider call, persists hides, and clears local interests', async () => {
  const now = Date.parse('2026-11-07T23:00:00Z');
  let stored = JSON.stringify({ version: 1, enabled: true, refreshedAt: now, saved: [], hidden: [], topics: [{
    label: 'Navigation', queries: ['Navigation history'], subjects: ['Navigation'], uses: 2, updatedAt: now, preferences: defaultPreferences(),
    videos: [{ video_id: 'abcdefghijk', title: 'Navigation documentary', channel: 'Example channel', description: '',
      published_at: '2026-11-01', duration_seconds: 1800, cachedAt: now, source: 'youtube_live' }],
  }] });
  const storage = { getItem: key => key === 'mytube.home.v1' ? stored : null, setItem: (key, value) => { if (key === 'mytube.home.v1') stored = value; } };
  const { document, start } = await loadPage({ storage, web: true });
  start();
  assert.equal(document.getElementById('new-search').textContent, 'New search');
  assert.equal(document.getElementById('current-topic').textContent, 'For you');
  assert.equal(document.querySelectorAll('.stream').length, 0);
  assert.equal(document.querySelectorAll('.direct .video-card, .related .video-card').length, 0);
  assert.equal(document.getElementById('home-tab').textContent, 'For you');
  assert.equal(document.getElementById('discover-tab'), null);
  document.getElementById('past-searches-button').click();
  assert.equal(document.querySelectorAll('#streams .video-card').length, 1);
  assert.equal(document.querySelectorAll('#past-searches-videos .video-card').length, 1);
  assert.equal(document.getElementById('past-searches-title').textContent, 'Past searches');
  const before = stored, checkbox = document.getElementById('remember-interests');
  const change = () => { checkbox.checked = false; checkbox.dispatchEvent(new document.defaultView.Event('change')); };
  change();
  assert.equal(stored, before); assert.equal(document.querySelectorAll('#streams .video-card').length, 1);
  document.getElementById('cancel-forget-history').click();
  assert.equal(stored, before); assert.equal(checkbox.checked, true);
  change();
  document.getElementById('forget-history-dialog').dispatchEvent(new document.defaultView.Event('cancel', { cancelable: true }));
  assert.equal(stored, before); assert.equal(checkbox.checked, true);
  assert.equal(document.getElementById('forget-history-dialog').hasAttribute('open'), false);
  document.querySelector('button[aria-label="Hide Navigation documentary"]').click();
  assert.equal(document.querySelectorAll('.video-card').length, 0);
  assert.deepEqual(JSON.parse(stored).hidden, ['abcdefghijk']);
  document.getElementById('settings-button').click(); document.getElementById('clear-home').click();
  assert.equal(JSON.parse(stored).topics.length, 1, 'Clear cache also waits for confirmation');
  document.getElementById('confirm-forget-history').click();
  assert.equal(JSON.parse(stored).topics.length, 0); assert.equal(JSON.parse(stored).hidden.length, 0);
});

test('web results render in MyTube without Google sign-in or invented duration and survive caching', async () => {
  const stored = new Map();
  const { document, window, start } = await loadPage({ web: true, storage: { getItem: k => stored.get(k), setItem: (k, v) => { stored.set(k, v); } },
    getAuthToken: () => assert.fail('Web discovery must not require Google login'),
    fetchImpl: async url => {
      assert.equal(url, 'http://127.0.0.1:43817/web-discover');
      return new Response(JSON.stringify({ searches: 1, videos: [{ video_id: 'abcdefghijk', title: 'Maya archaeology', channel: 'Museum', source: 'youtube_web',
        source_url: 'https://www.youtube.com/watch?v=abcdefghijk', discovery_stream: 'direct', discovery_why: 'Archaeological evidence',
        duration_seconds: null, published_at: null, views: null }] }), { headers: { 'content-type': 'application/json' } });
    } });
  start(); document.getElementById('new-search').click(); document.getElementById('query-input').value = 'Maya archaeology';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 100 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(document.querySelectorAll('#streams .video-card').length, 1);
  assert.equal(document.querySelector('.duration-badge'), null);
  assert.match(document.getElementById('collection-note').textContent, /not verified/);
  assert.equal(document.querySelector('.video-title').textContent, 'Maya archaeology');
  assert.equal(JSON.parse(stored.get('mytube.home.v1')).topics[0].videos[0].source, 'youtube_web');
  assert.equal(document.querySelector('.why'), null);
  assert.equal(document.querySelector('.card-details .ban-channel').textContent, 'Ban channel');
  document.querySelector('.save-video').click();
  assert.equal(document.querySelector('.save-video').textContent, 'Saved');
  document.getElementById('saved-tab').click();
  assert.equal(document.getElementById('current-topic').textContent, 'Saved videos');
  assert.equal(document.querySelectorAll('#streams .video-card').length, 1);
  document.getElementById('saved-tab').click();
  assert.equal(document.querySelectorAll('.direct .video-card').length, 1);
  document.querySelector('.brand').click(); document.getElementById('past-searches-button').click(); assert.equal(document.querySelectorAll('#past-searches-videos .video-card').length, 1);
  assert.equal(document.querySelectorAll('#past-searches-videos .video-card').length, 1);
});

test('oversized web results begin with eight per column and enforce platform diversity for Jokers', async () => {
  const videos = ['direct', 'adjacent', 'wildcard'].flatMap((stream, s) => Array.from({ length: 15 }, (_, i) => {
    const id = String(s * 15 + i).padStart(11, '0');
    return { video_id: id, title: `History ${stream} ${i}`, channel: `Museum ${s} ${i}`, source: 'youtube_web',
      source_url: `https://www.youtube.com/watch?v=${id}`, discovery_stream: stream, discovery_why: `Connection ${s} ${i}`,
      duration_seconds: null, published_at: null, views: null };
  }));
  const { document, window, start } = await loadPage({ web: true, fetchImpl: async () =>
    new Response(JSON.stringify({ searches: 6, videos }), { headers: { 'content-type': 'application/json' } }) });
  start(); document.getElementById('new-search').click(); document.getElementById('query-input').value = 'Chinese civilization';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 100 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(setImmediate);
  assert.equal(document.querySelectorAll('.video-card').length, 24);
  assert.equal(document.querySelectorAll('.wildcard .video-card').length, 8);
  for (const stream of ['direct', 'related']) assert.equal(document.querySelectorAll(`.stream.${stream} .video-card`).length, 8);
  assert.equal(document.querySelectorAll('.recent .video-card').length, 0);
});

test('configured private key uses only local routes, paints API results before planning, and adds external jokers in the third column', async () => {
  let releasePlan; const searches = [];
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const { document, window, start } = await loadPage({ web: true, preflight: true, localKey: true,
    windows: { create: async () => assert.fail('Already authenticated') }, fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:43817');
      assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers['X-Goog-Api-Key'], undefined);
      if (url.endsWith('/authorization')) return json({ authorization_url: null });
      if (url.endsWith('/connect')) return json({ connected: true });
      if (url.endsWith('/wildcard-discover')) return json({ searches: 1, videos: [{ video_id: 'web:https://vimeo.com/123456', source_url: 'https://vimeo.com/123456',
        platform: 'Vimeo', source: 'external_web', title: 'Pacific architecture', channel: 'Vimeo', channel_unknown: true,
        duration_seconds: null, published_at: null, views: null, discovery_stream: 'wildcard', discovery_why: 'Architecture across civilizations' }] });
      if (url.endsWith('/plan')) return new Promise(resolve => { releasePlan = () => resolve(json({ direct_subjects: ['direct archaeology'], queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream, query: `${stream} archaeology`, why: 'History connection' })) })); });
      assert.ok(url.endsWith('/youtube/search')); searches.push(JSON.parse(init.body).query);
      const offset = searches.length === 1 ? 0 : 8;
      return json({ requests: 2, search_results: 8, videos: Array.from({ length: 8 }, (_, i) => ({
        video_id: String(offset + i).padStart(11, '0'), title: `Maya archaeology ${offset + i}`, channel: `Museum ${offset + i}`,
        source: 'youtube_live', duration_seconds: 2100, published_at: '2024-01-01T00:00:00Z', views: 123, provider_rank: i + 1,
      })) });
    } });
  const settle = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate); assert.ok(predicate()); };
  start(); document.getElementById('new-search').click();
  await settle(() => document.getElementById('query-dialog').hasAttribute('open'));
  document.getElementById('query-input').value = 'Maya archaeology';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  try {
    await settle(() => document.querySelectorAll('.direct .video-card').length === 8);
    assert.equal(searches.length, 1); assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'true');
    assert.match(document.querySelector('.direct').textContent, /35 min/);
    releasePlan();
    await settle(() => document.getElementById('streams').getAttribute('aria-busy') === 'false');
    assert.equal(searches.length, 3); assert.equal(document.querySelectorAll('.related .video-card').length, 8);
    assert.equal(document.querySelector('.direct .video-card').getAttribute('data-video-id'), '00000000000');
    document.getElementById('review-request').click();
    assert.match(document.getElementById('generated-searches').textContent, /2 · Related topics \(ADJACENT\)/);
    assert.match(document.getElementById('generated-searches').textContent, /adjacent archaeology/);
    document.getElementById('close-request').click();
    assert.equal(document.getElementById('result-count').textContent, '17 / 24');
    assert.equal(document.querySelector('.wildcard .video-title a').getAttribute('href'), 'https://vimeo.com/123456');
    assert.equal(document.querySelector('.wildcard .ban-channel'), null);
  } finally { releasePlan?.(); if (document.getElementById('streams').getAttribute('aria-busy') === 'true') document.querySelector('.search-progress button')?.click(); }
});

test('web updates paint immediately with a live goal counter and stop the spinner on completion', async () => {
  let stream;
  const { document, window, start } = await loadPage({ web: true, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'application/x-ndjson' } }) });
  const video = (id, direction) => ({ video_id: id, title: `Maya ${id}`, channel: `Museum ${id}`, source: 'youtube_web', source_url: `https://www.youtube.com/watch?v=${id}`, discovery_stream: direction, discovery_why: 'History', duration_seconds: null, published_at: null, views: null });
  const one = video('abcdefghijk', 'direct'), two = video('lmnopqrstuv', 'adjacent');
  const send = value => stream.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
  const settle = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate); assert.ok(predicate()); };
  start(); document.getElementById('new-search').click(); document.getElementById('query-input').value = 'Maya history';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle(() => Boolean(stream));
  try {
    send({ type: 'progress', searches: 1, videos: [one] });
    await settle(() => document.querySelectorAll('.video-card').length === 1);
    assert.match(document.querySelector('.search-progress').textContent, /1 \/ 24 videos/);
    assert.ok(document.querySelector('.search-progress .loading-spinner'));
    assert.equal(document.querySelectorAll('.search-progress').length, 1);
    send({ type: 'progress', searches: 2, videos: [one, two] });
    await settle(() => document.querySelectorAll('.video-card').length === 2);
    assert.match(document.querySelector('.search-progress').textContent, /2 \/ 24 videos/);
    assert.equal(document.querySelector('.related .stream-number').textContent, '1 / 8');
    send({ type: 'result', searches: 6, videos: [one, two] }); stream.close();
    await settle(() => document.getElementById('streams').getAttribute('aria-busy') === 'false');
    assert.equal(document.querySelector('.loading-spinner'), null);
    assert.equal(document.querySelector('.search-progress'), null);
    assert.match(document.getElementById('status').textContent, /2 videos shown.*Search finished/);
  } finally { if (document.getElementById('streams').getAttribute('aria-busy') === 'true') document.querySelector('.search-progress button').click(); }
});

test('past searches stay available in their panel while three new columns fill', async () => {
  const streams = [];
  const { document, window, start } = await loadPage({ web: true, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { streams.push(controller); },
  }), { headers: { 'content-type': 'application/x-ndjson' } }) });
  const video = (id, direction) => ({ video_id: id, title: `History ${id}`, channel: `Channel ${id}`, source: 'youtube_web',
    source_url: `https://www.youtube.com/watch?v=${id}`, discovery_stream: direction, discovery_why: 'History', duration_seconds: null, published_at: null, views: null });
  const old = [video('aaaaaaaaaaa', 'direct'), video('bbbbbbbbbbb', 'direct'), video('ccccccccccc', 'direct'), video('ddddddddddd', 'adjacent'), video('eeeeeeeeeee', 'wildcard')];
  const one = video('fffffffffff', 'direct'), two = video('ggggggggggg', 'direct');
  const settle = async predicate => { for (let i = 0; i < 120 && !predicate(); i++) await new Promise(setImmediate); assert.ok(predicate()); };
  const submit = text => {
    document.getElementById('new-search').click(); document.getElementById('query-input').value = text;
    document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  };
  const send = (index, type, videos) => streams[index].enqueue(new TextEncoder().encode(JSON.stringify({ type, searches: 3, videos }) + '\n'));
  const ids = direction => [...document.querySelectorAll(direction === 'recent' ? '#past-searches-videos .video-card' : `#streams .${direction} .video-card`)].map(n => n.getAttribute('data-video-id'));
  const pending = () => document.getElementById('streams').getAttribute('aria-busy') === 'true';
  start();
  try {
    submit('Old history'); await settle(() => streams.length === 1);
    send(0, 'result', old); streams[0].close(); await settle(() => !pending());
    submit('New history'); await settle(() => streams.length === 2);
    document.getElementById('past-searches-button').click();
    assert.deepEqual(ids('recent'), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee']);
    assert.deepEqual(ids('direct'), []); assert.deepEqual(ids('related'), []);
    assert.equal(document.querySelectorAll('.pending-replacement,.previous-results-boundary').length, 0);
    assert.ok(document.getElementById('current-topic').classList.contains('query-loading'));
    assert.match(document.querySelector('.search-progress').textContent, /0 \/ 24 videos/);
    const retained = document.querySelector('[data-video-id="ccccccccccc"]');
    const retainedBan = retained.querySelector('.ban-channel');
    send(1, 'progress', [one]); await settle(() => ids('direct')[0] === one.video_id);
    assert.deepEqual(ids('direct'), ['fffffffffff']);
    assert.deepEqual(ids('recent'), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee']);
    assert.equal(document.querySelector('[data-video-id="ccccccccccc"]'), retained);
    assert.equal(retained.querySelector('.ban-channel'), retainedBan);
    send(1, 'progress', [one, two]); await settle(() => ids('direct')[1] === two.video_id);
    assert.deepEqual(ids('direct'), ['fffffffffff', 'ggggggggggg']);
    assert.equal(document.getElementById('result-count').textContent, '2 / 24');
    send(1, 'result', [one, two]); streams[1].close(); await settle(() => !pending());
    assert.equal(document.querySelectorAll('.pending-replacement').length, 0);
    assert.equal(document.querySelectorAll('#past-searches-videos .video-card').length, 5);
    assert.equal(document.getElementById('current-topic').classList.contains('query-loading'), false);
    document.getElementById('close-past-searches').click();
    submit('Third history'); await settle(() => streams.length === 3);
    document.getElementById('past-searches-button').click();
    document.querySelector('.search-progress button').click();
    assert.equal(pending(), false);
    assert.equal(document.querySelectorAll('.pending-replacement').length, 0);
    const older = document.querySelectorAll('.archived-search')[2];
    older.setAttribute('open', ''); older.dispatchEvent(new window.Event('toggle'));
    assert.equal(document.querySelectorAll('.video-card').length, 7);
    assert.equal(document.getElementById('current-topic').classList.contains('query-loading'), false);
    send(2, 'progress', [old[0]]); streams[2].close();
    await new Promise(setImmediate);
    assert.deepEqual(ids('direct'), []);
    assert.deepEqual(ids('recent'), ['fffffffffff', 'ggggggggggg', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee']);
  } finally {
    if (pending()) document.querySelector('.search-progress button')?.click();
  }
});

test('progress disappears at twelve while separate joker results keep arriving', async () => {
  let stream;
  const { document, window, start } = await loadPage({ web: true, fetchImpl: async () => new Response(new ReadableStream({ start(c) { stream = c; } }), { headers: { 'content-type': 'application/x-ndjson' } }) });
  const videos = Array.from({ length: 16 }, (_, i) => ({ video_id: String(i).padStart(11, '0'), title: `History ${i}`, channel: `Channel ${i}`,
    source: 'youtube_web', source_url: `https://www.youtube.com/watch?v=${String(i).padStart(11, '0')}`, discovery_stream: i < 8 ? 'direct' : i < 13 ? 'adjacent' : 'wildcard',
    discovery_why: `Angle ${i}`, duration_seconds: null, published_at: null, views: null }));
  const settle = async predicate => { for (let i = 0; i < 120 && !predicate(); i++) await new Promise(setImmediate); assert.ok(predicate()); };
  const send = (type, rows) => stream.enqueue(new TextEncoder().encode(JSON.stringify({ type, searches: 4, videos: rows }) + '\n'));
  start(); document.getElementById('query-input').value = 'History';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle(() => Boolean(stream));
  try {
    send('progress', videos.slice(0, 11)); await settle(() => document.querySelectorAll('.video-card').length === 11);
    assert.ok(document.querySelector('.search-progress'));
    send('progress', videos.slice(0, 12)); await settle(() => document.querySelectorAll('.video-card').length === 12);
    assert.equal(document.querySelector('.search-progress'), null);
    assert.equal(document.getElementById('current-topic').classList.contains('query-loading'), false);
    assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'true');
    assert.ok(document.getElementById('quiet-cancel'));
    send('result', videos); stream.close();
    await settle(() => document.getElementById('streams').getAttribute('aria-busy') === 'false');
    assert.equal(document.querySelectorAll('.direct .video-card').length, 8);
    assert.equal(document.querySelectorAll('.related .video-card').length, 5);
    assert.equal(document.querySelectorAll('.wildcard .video-card').length, 3);
    assert.equal(document.getElementById('quiet-cancel'), null);
  } finally { document.querySelector('#quiet-cancel,.search-progress button')?.click(); }
});

test('fresh search layout stays idle without network and saved picks remain accessible from details', async () => {
  const { document, start } = await loadPage({ web: true });
  start();
  assert.equal(document.querySelectorAll('.stream').length, 0);
  assert.equal(document.querySelectorAll('.video-card, .loading-spinner').length, 0);
  assert.equal(document.querySelector('.collection-heading').hidden, true);
  assert.equal(document.getElementById('current-topic').textContent, 'For you');
  document.getElementById('new-search').click();
  assert.ok(document.getElementById('query-dialog').hasAttribute('open'));
  document.getElementById('close-query').click();
  document.getElementById('saved-tab').click();
  assert.match(document.getElementById('streams').textContent, /No saved videos/);
  document.getElementById('saved-tab').click();
  assert.equal(document.querySelectorAll('.stream').length, 0);
});

test('reopening image-less external cards retrieves previews and durations and persists them', async () => {
  const now = Date.parse('2026-11-07T23:00:00Z'), data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const video = { video_id: 'web:https://vimeo.com/973190544', source_url: 'https://vimeo.com/973190544',
    platform: 'Vimeo', source: 'external_web', channel: 'Vimeo', channel_unknown: true, title: 'Parallax discussion',
    duration_seconds: null, published_at: null, views: null, cachedAt: now, discovery_stream: 'wildcard', discovery_why: 'Film discussion' };
  data.set('mytube.last-search.v1', JSON.stringify({ version: 1, savedAt: now, query: 'Parallax', preferences: defaultPreferences(), videos: [video] }));
  let calls = 0;
  const { document, start } = await loadPage({ web: true, previews: true, storage, fetchImpl: async url => {
    calls++; assert.equal(new URL(url).hostname, 'vimeo.com');
    return new Response(JSON.stringify({ thumbnail_url: 'https://i.vimeocdn.com/video/123.jpg', duration: 1500 }), { headers: { 'content-type': 'application/json' } });
  } });
  start(); document.getElementById('search-tab').click();
  for (let i = 0; i < 100 && !document.querySelector('.wildcard .cover img'); i++) await new Promise(setImmediate);
  assert.equal(document.querySelector('.wildcard .cover img')?.src, 'https://i.vimeocdn.com/video/123.jpg');
  assert.equal(document.querySelector('.wildcard .duration-badge')?.textContent, '25 min');
  assert.equal(document.querySelector('.wildcard-joker'), null);
  assert.match(document.querySelector('.wildcard h3').textContent, /Unexpected discoveries/);
  const cached = JSON.parse(data.get('mytube.last-search.v1')).videos[0];
  assert.equal(cached.thumbnail_url, 'https://i.vimeocdn.com/video/123.jpg'); assert.equal(cached.duration_seconds, 1500);
  const reopened = await loadPage({ web: true, previews: true, storage, fetchImpl: async () => assert.fail('Preview is already cached') });
  reopened.start(); reopened.document.getElementById('search-tab').click(); await new Promise(setImmediate);
  assert.equal(reopened.document.querySelector('.wildcard .cover img')?.src, cached.thumbnail_url);
  assert.equal(calls, 1);
});
