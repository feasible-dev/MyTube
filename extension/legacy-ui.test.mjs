import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences } from './preferences.mjs';
import { loadLegacyPage as loadPage } from './ui-harness.mjs';

test('clearing history keeps its status after a cancelled background refresh fails late', async () => {
  const now = Date.parse('2026-11-07T23:00:00Z'), data = new Map();
  data.set('mytube.home.v1', JSON.stringify({ version: 1, enabled: true, refreshedAt: now,
    topics: [{ label: 'Navigation', queries: ['Navigation history'], subjects: ['Navigation'],
      preferences: defaultPreferences(), updatedAt: now, uses: 1, videos: [] }] }));
  let rejectAuth;
  const { document, start } = await loadPage({
    storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
    getAuthToken: () => new Promise((_, reject) => { rejectAuth = reject; }),
  });
  start(); document.getElementById('refresh-home').click();
  assert.equal(typeof rejectAuth, 'function');
  document.getElementById('clear-home').click();
  document.getElementById('confirm-forget-history').click();
  const status = document.getElementById('home-status').textContent;
  assert.equal(status, 'Interests and cache cleared.');
  rejectAuth(new Error('Late sign-in failure'));
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.equal(document.getElementById('home-status').textContent, status);
  assert.equal(JSON.parse(data.get('mytube.home.v1')).topics.length, 0);
});

test('background home refresh requests only noninteractive Google sign-in and keeps cache if unavailable', async () => {
  const now = Date.parse('2026-11-07T23:00:00Z'); let auth = 0;
  let stored = JSON.stringify({ version: 1, enabled: true, refreshedAt: 0, topics: [{ label: 'Navigation', queries: ['Navigation history'],
    subjects: ['Navigation'], preferences: defaultPreferences(), updatedAt: now, uses: 1, videos: [] }] });
  const { document, start } = await loadPage({ storage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } },
    getAuthToken: async options => { auth++; assert.equal(options.interactive, false); throw Error('Not connected'); } });
  start();
  assert.equal(auth, 0);
  for (let i = 0; i < 80 && !auth; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(auth, 1); assert.equal(JSON.parse(stored).topics.length, 1);
  assert.ok(document.getElementById('home-status').textContent.includes('cached'));
});

test('empty quota failure offers a safe YouTube fallback and preserves the original request', async () => {
  const intention = 'History of Machu Picchu & archaeology';
  const { document, window, start } = await loadPage({
    getAuthToken: async () => ({ token: 'UI_TOKEN_CANARY_123456789', grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] }),
    fetchImpl: async (url, init) => {
      if (new URL(url).hostname === '127.0.0.1') return new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
      return new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), { status: 429 });
    },
  });
  start(); document.getElementById('new-search').click(); document.getElementById('query-input').value = intention;
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 100 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'false');
  assert.match(document.getElementById('streams').textContent, /quota is exhausted/);
  assert.match(document.getElementById('streams').textContent, /No cached results/);
  const link = document.querySelector('#streams a');
  assert.equal(new URL(link.getAttribute('href')).searchParams.get('search_query'), intention);
  assert.equal(link.rel, 'noopener noreferrer');
  document.getElementById('review-request').click();
  assert.equal(document.getElementById('original-request').textContent, intention);
  assert.match(document.getElementById('generated-searches').textContent, /QUOTA_EXCEEDED/);
});

test('historical demo starts with its 27 fixture cards and opens and closes New search', async () => {
  const { document, start, configured } = await loadPage();
  assert.equal(document.querySelector('#query-dialog select'), null);
  start();
  assert.equal(document.querySelectorAll('.video-card').length, 27);
  assert.equal(document.querySelectorAll('.video-card .ai-status').length, 0);
  assert.equal(document.querySelectorAll('.card-bottom').length, 0);
  assert.equal(document.querySelectorAll('.card-body .why').length, 0);
  assert.equal(document.querySelectorAll('.card-details .ban-channel').length, 27);
  assert.ok([...document.querySelectorAll('.video-card button')].every(button => button.textContent !== '+'));
  document.getElementById('new-search').click();
  assert.ok(document.getElementById('query-dialog').hasAttribute('open'));
  assert.equal(document.getElementById('submit-query').disabled, !configured);
  document.getElementById('close-query').click();
  assert.ok(!document.getElementById('query-dialog').hasAttribute('open'));
});

test('videos display before channel avatars, and broken images restore the channel initial', async () => {
  const channelId = 'UC' + 'a'.repeat(22);
  let release, avatarCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const { document, window, start } = await loadPage({
    getAuthToken: async () => ({ token: 'AVATAR_TEST_TOKEN_123456789', grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] }),
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') return json({ queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream, query: `physics university lectures ${stream}`, why: 'A synthetic test connection' })) });
      if (u.pathname.endsWith('/channels')) {
        avatarCalls++; await pending;
        return json({ items: [{ id: channelId, snippet: { thumbnails: { default: { url: 'https://yt3.ggpht.com/synthetic-channel=s88' } } } }] });
      }
      if (u.pathname.endsWith('/search')) return json({ items: [{ id: { videoId: 'abcdefghijk' } }] });
      return json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Physics university lecture', channelTitle: 'Example University', channelId,
        description: '', publishedAt: '2024-01-01T00:00:00Z', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT45M' }, statistics: {} }] });
    },
  });
  start(); document.getElementById('new-search').click(); document.getElementById('query-input').value = 'Physics lectures';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  try {
    for (let i = 0; i < 100 && !avatarCalls; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(document.querySelectorAll('.video-card').length, 1);
    assert.equal(document.querySelector('.channel-avatar').textContent, 'E');
    assert.equal(document.querySelector('.channel-avatar img'), null);
  } finally { release(); }
  for (let i = 0; i < 100 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(avatarCalls, 1);
  const image = document.querySelector('.channel-avatar img');
  assert.equal(image.getAttribute('src'), 'https://yt3.ggpht.com/synthetic-channel=s88');
  assert.equal(image.referrerPolicy, 'no-referrer');
  image.dispatchEvent(new window.Event('error'));
  assert.equal(document.querySelector('.channel-avatar img'), null);
  assert.equal(document.querySelector('.channel-avatar').textContent, 'E');
});

test('clean settings expose eight independent axes, languages and a paired range, then submit their snapshot', async () => {
  const calls = [];
  let preferences;
  const { document, window, start } = await loadPage({
    getAuthToken: async () => ({ token: 'PREFERENCES_TEST_TOKEN_12345', grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] }),
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (new URL(url).hostname === '127.0.0.1') {
        preferences = JSON.parse(options.body).preferences;
        return new Response(JSON.stringify({ queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream, query: `${stream} historical lectures`, why: 'A synthetic connection for tests' })) }), { headers: { 'content-type': 'application/json' } });
      }
      assert.equal(new URL(url).searchParams.get('relevanceLanguage'), 'fr');
      return new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
    },
  });
  start();
  assert.equal(document.querySelectorAll('.topic-actions button').length, 2);
  assert.equal(document.querySelectorAll('#language-options input').length, 15);
  assert.ok(document.querySelectorAll('#more-languages input').length > 0);
  document.getElementById('settings-button').click();
  const originality = document.getElementById('pref-originality');
  assert.equal(Number(originality.value), 50);
  originality.value = 75; originality.dispatchEvent(new window.Event('input'));
  assert.match(originality.getAttribute('aria-valuetext'), /Adventurous/);
  for (const [axis, value] of [['origin', 100], ['audience', 0], ['depth', 85], ['perspective', 100], ['politics', 20]]) {
    const slider = document.getElementById(`pref-${axis}`);
    assert.equal(Number(slider.value), 50);
    slider.value = value; slider.dispatchEvent(new window.Event('input'));
  }
  const english = document.querySelector('[data-language="en"]');
  english.checked = false; english.dispatchEvent(new window.Event('change'));
  assert.equal(english.checked, true, 'Cannot remove the last selected language');
  const french = document.querySelector('[data-language="fr"]');
  french.checked = true; french.dispatchEvent(new window.Event('change'));
  english.checked = false; english.dispatchEvent(new window.Event('change'));
  for (const [side, value] of [['min', 5], ['max', 180]]) {
    const slider = document.getElementById(`${side}-duration`);
    slider.value = value; slider.dispatchEvent(new window.Event('input'));
  }
  document.getElementById('done-settings').click();
  assert.equal(calls.length, 0, 'Changing preferences does not sign in or call providers');
  document.getElementById('new-search').click();
  document.getElementById('query-input').value = 'History lectures';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 100 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(preferences, { origin: 100, audience: 0, depth: 75, perspective: 100, politics: 25, recency: 50, popularity: 50, originality: 75, minMinutes: 5, maxMinutes: 180, languages: ['fr'] });
  assert.equal(calls.length, 6, 'One quick lookup plus an empty-result replan; generated queries are not repeated');
  document.getElementById('settings-button').click(); document.getElementById('reset-preferences').click();
  assert.equal(Number(document.getElementById('pref-politics').value), 50);
  assert.equal(english.checked, true); assert.equal(french.checked, false);
});

test('unavailable YouTube search does not silently search the saved collection', async () => {
  const { document, window, start } = await loadPage({ live: false });
  start(); document.getElementById('new-search').click();
  assert.match(document.getElementById('query-help').textContent, /file preview/);
  assert.equal(document.getElementById('submit-query').disabled, true);
  document.getElementById('query-input').value = 'mathematics';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.ok(document.getElementById('query-dialog').hasAttribute('open'));
  assert.match(document.getElementById('query-error').textContent, /file preview/);
  assert.equal(document.querySelectorAll('.video-card').length, 27);
});

test('long intention flows through the packaged UI, local planner, Google auth and three discovery streams', async () => {
  const calls = [], token = 'UI_TOKEN_CANARY_123456789';
  let intention = 'I would like serious lectures about nuclear safety, avoiding sensationalist content. '.repeat(20).trim();
  const plan = { queries: ['direct', 'adjacent', 'wildcard'].map((stream, i) => ({ stream,
    query: ['nuclear safety lectures', 'industrial risk analysis', 'history of safety regulation'][i], why: 'A synthetic connection for testing only' })) };
  let authCalls = 0;
  const { document, window, start, configured } = await loadPage({
    windows: { create: () => assert.fail('An existing session needs no popup') },
    getAuthToken: async () => { authCalls++; return { token, grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] }; },
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/authorization') {
        assert.match(options.headers['X-MyTube-Request'], /^[a-f0-9-]{36}$/);
        return new Response('{"authorization_url":null}', { headers: { 'content-type': 'application/json' } });
      }
      const request = new URL(url); calls.push(request);
      if (request.hostname === '127.0.0.1') {
        assert.match(options.headers['X-MyTube-Request'], /^[a-f0-9-]{36}$/);
        assert.equal(authCalls, 0); assert.equal(options.headers.Authorization, undefined);
        assert.equal(JSON.parse(options.body).intention, intention);
        return new Response(JSON.stringify(plan), { headers: { 'content-type': 'application/json' } });
      }
      assert.equal(request.origin, 'https://www.googleapis.com');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.ok(!url.includes(token));
      assert.ok(calls.length <= 7);
      const items = request.pathname.endsWith('/search') ? [{ id: { videoId: 'abcdefghijk' } }] : [{
        id: 'abcdefghijk', snippet: { title: '<img src=x onerror=alert(1)> A lecture', channelTitle: 'Example University',
          description: 'Fixture metadata', publishedAt: '2024-01-01T00:00:00Z', liveBroadcastContent: 'none' },
        contentDetails: { duration: 'PT45M' }, statistics: { viewCount: '50' },
      }];
      return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.ok(configured, 'Integration fixture requires the configured development package');
  start();
  assert.equal(authCalls, 0);
  document.getElementById('new-search').click();
  document.getElementById('query-input').value = intention;
  assert.equal(document.getElementById('query-help').hidden, true);
  assert.equal(calls.length, 0, 'Opening the search dialog must not send requests');
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 200 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(authCalls, 1);
  assert.equal(calls.length, 7);
  assert.equal(calls[1].searchParams.get('q'), 'nuclear safety lectures');
  assert.equal(calls[1].searchParams.has('pageToken'), false);
  assert.equal(document.getElementById('current-topic').textContent, intention.slice(0, 100) + '…');
  assert.equal(document.getElementById('current-topic').title, intention);
  assert.equal(document.getElementById('result-count').textContent, '1');
  assert.equal(document.getElementById('result-count').hidden, false);
  assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'false');
  assert.equal(document.getElementById('loading-time'), null);
  assert.match(document.querySelector('.video-title').textContent, /<img src=x/);
  assert.equal(document.querySelector('.video-title img'), null, 'Provider text must not become markup');
  assert.ok(!document.toString().includes(token));
  assert.equal(document.getElementById('youtube-search'), null);
  assert.equal(document.getElementById('nasa-example'), null);
  document.getElementById('review-request').click();
  assert.equal(document.getElementById('original-request').textContent, intention);
  assert.equal(document.querySelectorAll('#generated-searches .generated-query').length, 3);
  assert.equal(document.querySelector('#generated-searches .generated-query').textContent, 'nuclear safety lectures');
  document.getElementById('edit-request').click();
  assert.equal(document.getElementById('query-input').value, intention);
  assert.equal(document.getElementById('query-title').textContent, 'Edit your request');
  document.getElementById('query-input').value = 'Unsubmitted draft';
  document.getElementById('query-input').dispatchEvent(new window.Event('input'));
  document.getElementById('cancel-query').click();
  document.getElementById('review-request').click();
  assert.equal(document.getElementById('original-request').textContent, intention, 'A draft must not replace the text that produced these results');
  assert.equal(calls.length, 7, 'Review and editing do not trigger provider requests');
  document.getElementById('edit-request').click();
  intention = 'Je veux des analyses de films des années 70, pas un seul film. <img src=x onerror=alert(1)>';
  document.getElementById('query-input').value = intention;
  calls.length = 0; authCalls = 0;
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 200 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 7);
  document.getElementById('review-request').click();
  assert.equal(document.getElementById('original-request').textContent, intention);
  assert.equal(document.querySelector('#original-request img'), null);
});

test('an unavailable connector preserves the long draft and never starts YouTube sign-in', async () => {
  const { document, window, start } = await loadPage({ fetchImpl: async () => { throw Error('offline'); } });
  start(); document.getElementById('new-search').click();
  document.getElementById('query-input').value = 'x'.repeat(301);
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 30 && !document.getElementById('streams').textContent.includes('connector'); i++) await new Promise(setImmediate);
  assert.match(document.getElementById('streams').textContent, /connector/);
  assert.equal(document.querySelectorAll('.video-card').length, 0);
  document.getElementById('new-search').click();
  assert.equal(document.getElementById('query-input').value, 'x'.repeat(301));
});

test('pending search shows elapsed time and stages without a zero count; cancellation stops updates', async () => {
  let now = Date.parse('2026-11-07T23:00:00Z'), tick, releasePlan, releaseAuth, authCalls = 0;
  const plan = new Promise(resolve => { releasePlan = resolve; });
  const auth = new Promise(resolve => { releaseAuth = resolve; });
  const { document, window, start } = await loadPage({ clock: () => now,
    interval: fn => { assert.equal(tick, undefined); tick = fn; return 1; },
    clear: id => { assert.equal(id, 1); tick = undefined; },
    fetchImpl: async url => { assert.equal(new URL(url).hostname, '127.0.0.1'); return plan; },
    getAuthToken: async () => { authCalls++; return auth; },
  });
  start(); document.getElementById('new-search').click();
  document.getElementById('query-input').value = 'Physics documentaries';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.equal(document.getElementById('result-count').hidden, true);
  assert.equal(document.getElementById('result-count').textContent, '');
  assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'true');
  assert.match(document.getElementById('streams').textContent, /while ChatGPT prepares/);
  assert.match(document.getElementById('streams').textContent, /as each search finishes/);
  now += 65000; tick();
  assert.equal(document.getElementById('loading-time').textContent, '1:05 elapsed');
  releasePlan(new Response(JSON.stringify({ queries: ['direct', 'adjacent', 'wildcard'].map((stream, i) => ({ stream,
    query: ['physics documentaries', 'mathematics lectures', 'history of instruments'][i], why: 'Synthetic test connection only' })) }),
    { headers: { 'content-type': 'application/json' } }));
  for (let i = 0; i < 30 && !document.getElementById('streams').textContent.includes('Finding videos on YouTube'); i++) await new Promise(setImmediate);
  assert.match(document.getElementById('streams').textContent, /Finding videos on YouTube/);
  assert.equal(document.getElementById('loading-time').textContent, '1:05 elapsed');
  document.querySelector('#streams button').click();
  assert.equal(tick, undefined);
  assert.equal(document.getElementById('loading-time'), null);
  assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'false');
  assert.equal(document.getElementById('result-count').hidden, true);
  releaseAuth({ token: 'CANCELLED_TOKEN_CANARY_12345', grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] });
  await new Promise(setImmediate);
  assert.match(document.getElementById('streams').textContent, /cancelled/i);
});

test('partial discoveries appear before a slow direction and survive a later provider failure', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const plan = { queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream, query: `${stream} synthetic lectures`, why: 'Synthetic connection for tests' })) };
  const { document, window, start } = await loadPage({
    getAuthToken: async () => ({ token: 'SYNTHETIC_TOKEN_123456789', grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] }),
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') return new Response(JSON.stringify(plan), { headers: { 'content-type': 'application/json' } });
      if (u.searchParams.get('q')?.startsWith('wildcard')) { await held; return new Response('', { status: 503 }); }
      const items = u.pathname.endsWith('/search') ? [{ id: { videoId: 'abcdefghijk' } }] : [{ id: 'abcdefghijk',
        snippet: { title: 'Synthetic lecture', channelTitle: 'Example University', description: '', publishedAt: '2024-01-01T00:00:00Z', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT45M' }, statistics: {} }];
      return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
    },
  });
  start(); document.getElementById('query-input').value = 'Synthetic request';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  try {
    for (let i = 0; i < 30 && !document.querySelector('.video-card'); i++) await new Promise(setImmediate);
    assert.ok(document.querySelector('.video-card'));
    assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'true');
    assert.match(document.querySelector('.search-progress').textContent, /Finding more/);
    assert.equal(document.getElementById('result-count').hidden, false);
  } finally { release(); }
  for (let i = 0; i < 30 && document.getElementById('streams').getAttribute('aria-busy') === 'true'; i++) await new Promise(setImmediate);
  assert.ok(document.querySelector('.video-card'), 'Completed results survive provider failure');
  assert.match(document.querySelector('.search-progress').textContent, /Keeping available results/);
  assert.equal(document.getElementById('loading-time'), null);
});

test('settings sliders filter existing results, keep valid bounds, and reset inside the panel', async () => {
  const { document, window, start } = await loadPage();
  start();
  assert.equal(document.querySelector('main #reset'), null);
  assert.equal(document.querySelector('main #min-duration'), null);
  document.getElementById('settings-button').click();
  assert.ok(document.getElementById('settings-dialog').hasAttribute('open'));
  const minimum = document.getElementById('min-duration');
  minimum.value = '100'; minimum.dispatchEvent(new window.Event('input'));
  assert.equal(document.getElementById('min-duration-value').textContent, '100 min');
  assert.ok(document.querySelectorAll('.video-card').length < 27);
  const maximum = document.getElementById('max-duration');
  maximum.value = '60'; maximum.dispatchEvent(new window.Event('input'));
  assert.equal(String(minimum.value), '60');
  assert.equal(String(maximum.value), '60');
  document.getElementById('reset').click();
  assert.equal(String(minimum.value), '20'); assert.equal(String(maximum.value), '120');
  assert.equal(document.querySelectorAll('.video-card').length, 27);
  document.getElementById('done-settings').click();
  assert.equal(document.getElementById('settings-dialog').hasAttribute('open'), false);
});

test('settings sign-out sends only a protected local request and shows completion', async () => {
  let calls = 0;
  const { document, start } = await loadPage({ fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'http://127.0.0.1:43817/signout');
    assert.equal(init.method, 'POST'); assert.equal(init.body, '{}'); assert.equal(init.headers.Authorization, undefined);
    return new Response('{"signed_out":true}', { headers: { 'content-type': 'application/json' } });
  } });
  start(); document.getElementById('settings-button').click();
  assert.equal(calls, 0); document.getElementById('signout-chatgpt').click();
  for (let i = 0; i < 30 && document.getElementById('signout-chatgpt').disabled; i++) await new Promise(setImmediate);
  assert.equal(calls, 1); assert.match(document.getElementById('session-status').textContent, /Signed out/);
});
