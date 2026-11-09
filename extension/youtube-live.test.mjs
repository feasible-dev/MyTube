import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fetchYouTubeResults, getGoogleToken, YOUTUBE_SCOPE, LiveSearchError, createChannelAvatarLoader, createVideoDurationLoader } from './youtube-live.mjs';
import { validChannelAvatar } from './channel-avatar.mjs';
import { defaultPreferences } from './preferences.mjs';
import { buildBrowserScript } from '../scripts/browser-bundle.mjs';

const token = 'TOKEN_CANARY_do_not_log_12345';
test('duration metadata is batched, cached and excludes live or unavailable durations', async () => {
  let calls = 0;
  const load = createVideoDurationLoader({ getToken: async () => token, fetchImpl: async url => {
    calls++; const u = new URL(url); assert.equal(u.pathname, '/youtube/v3/videos');
    assert.equal(u.searchParams.get('part'), 'contentDetails,snippet');
    return new Response(JSON.stringify({ items: [
      { id: 'aaaaaaaaaaa', snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT1H2M3S' } },
      { id: 'bbbbbbbbbbb', snippet: { liveBroadcastContent: 'live' }, contentDetails: { duration: 'PT10M' } },
      { id: 'ccccccccccc', snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT0S' } },
    ] }), { headers: { 'content-type': 'application/json' } });
  } });
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
  const [a, b] = await Promise.all([load(ids), load(ids)]);
  assert.deepEqual(a, [{ video_id: ids[0], duration_seconds: 3723 }]); assert.deepEqual(b, a);
  assert.equal(calls, 1);
});
test('unavailable duration authorization stops quietly without repeated token requests', async () => {
  let calls = 0;
  const load = createVideoDurationLoader({ getToken: async () => { calls++; throw Error('No cached authorization'); }, fetchImpl: () => assert.fail('No token') });
  assert.deepEqual(await load(['aaaaaaaaaaa']), []);
  assert.deepEqual(await load(['bbbbbbbbbbb']), []);
  assert.equal(calls, 1);
});
test('duration responses cannot attach metadata to an unrequested video', async () => {
  const load = createVideoDurationLoader({ getToken: async () => token, fetchImpl: async () => new Response(JSON.stringify({ items: [
    { id: 'bbbbbbbbbbb', snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT45M' } },
  ] }), { headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(await load(['aaaaaaaaaaa']), []);
});
const id = 'abcdefghijk', other = 'lmnopqrstuv';
const item = (videoId = id) => ({ id: videoId, snippet: { title: 'A university lecture', channelTitle: 'Test University',
  description: 'Public metadata', publishedAt: '2024-01-02T00:00:00Z', liveBroadcastContent: 'none' },
  contentDetails: { duration: 'PT45M' }, statistics: { viewCount: '51' } });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const page = ids => ({ items: ids.map(videoId => ({ id: { videoId } })) });
const run = (fetchImpl, extra = {}) => fetchYouTubeResults({ query: 'math & lectures', token, fetchImpl, ...extra });

test('channel pictures use bounded batches and share pending lookups by channel ID', async () => {
  const channelId = 'UC' + 'a'.repeat(22), avatar = 'https://yt3.ggpht.com/channel-photo=s88';
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const load = createChannelAvatarLoader({ token, fetchImpl: async (url, options) => {
    calls++; const u = new URL(url);
    assert.equal(u.origin, 'https://www.googleapis.com'); assert.equal(u.pathname, '/youtube/v3/channels');
    assert.equal(u.searchParams.get('id'), channelId); assert.equal(u.searchParams.get('maxResults'), '50');
    assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.redirect, 'error');
    await pending; return json({ items: [{ id: channelId, snippet: { thumbnails: { default: { url: avatar } } } }] });
  } });
  const a = [{ channel_id: channelId }, { channel_id: channelId }], b = [{ channel_id: channelId }];
  const first = load(a), second = load(b); release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls, 1); assert.ok([...a, ...b].every(v => v.channel_avatar === avatar));
  await load([{ channel_id: channelId }]); assert.equal(calls, 1);
});

test('unsafe pictures, wrong channel identities and unavailable avatar service keep the letter fallback', async () => {
  for (const url of ['https://evil.example/photo', 'http://yt3.ggpht.com/a', 'https://yt3.ggpht.com.evil.example/a',
    'https://user:pass@yt3.ggpht.com/a', 'data:image/svg+xml,test', 'https://yt3.ggpht.com:123/a']) assert.equal(validChannelAvatar(url), false);
  assert.ok(validChannelAvatar('https://yt3.googleusercontent.com/picture=s88'));
  const channelId = 'UC' + 'a'.repeat(22);
  for (const response of [() => new Response('unavailable', { status: 503 }),
    () => json({ items: [{ id: 'UC' + 'b'.repeat(22), snippet: {} }] }),
    () => json({ items: [{ id: channelId, snippet: { thumbnails: { default: { url: 'https://evil.example/picture' } } } }] })]) {
    let calls = 0;
    const load = createChannelAvatarLoader({ token, fetchImpl: async () => { calls++; return response(); } });
    const rows = [{ channel_id: channelId }];
    assert.equal(await load(rows), false); assert.equal(await load(rows), false);
    assert.equal(rows[0].channel_avatar, undefined); assert.equal(calls, 1, 'Optional failure is not retried');
  }
});

test('chosen duration and known audio language constrain results, while unknown language remains eligible', async () => {
  const preferences = { ...defaultPreferences(), minMinutes: 5, maxMinutes: 180, languages: ['fr'] };
  const ids = [id, other, '12345678901', '12345678902', '12345678903'];
  const items = ids.map(item);
  for (const row of items) row.snippet.defaultAudioLanguage = 'fr-CA';
  items[0].contentDetails.duration = 'PT5M';
  items[1].contentDetails.duration = 'PT3H';
  items[2].snippet.defaultAudioLanguage = 'en';
  items[3].contentDetails.duration = 'PT3H1M';
  delete items[4].snippet.defaultAudioLanguage;
  const result = await run(async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search')) {
      assert.equal(u.searchParams.has('videoDuration'), false);
      assert.equal(u.searchParams.get('relevanceLanguage'), 'fr');
      return json(page(ids));
    }
    assert.match(u.searchParams.get('fields'), /defaultAudioLanguage/);
    return json({ items });
  }, { preferences });
  assert.deepEqual(result.videos.map(v => v.video_id), [id, other, ids[4]]);
});

test('live search uses two fixed read-only requests, headers-only auth, and no pagination', async () => {
  const calls = [];
  const result = await run(async (url, options) => {
    calls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://www.googleapis.com');
    assert.ok(!url.includes(token));
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET'); assert.equal(options.referrerPolicy, 'no-referrer');
    if (calls.length === 1) {
      assert.equal(parsed.pathname, '/youtube/v3/search');
      assert.equal(parsed.searchParams.get('q'), 'math & lectures');
      assert.equal(parsed.searchParams.get('maxResults'), '50');
      assert.equal(parsed.searchParams.get('videoDuration'), 'long');
      return json({ ...page([id, id, other]), nextPageToken: 'ignored' });
    }
    assert.equal(parsed.pathname, '/youtube/v3/videos');
    assert.equal(parsed.searchParams.get('id'), `${id},${other}`);
    return json({ items: [item(other), item(id)] });
  });
  assert.equal(calls.length, 2); assert.equal(result.requests, 2);
  assert.deepEqual(result.videos.map(v => v.video_id), [id, other]);
  assert.equal(result.videos[0].views, 51);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('empty searches stop after one request', async () => {
  let calls = 0;
  const result = await run(async () => { calls++; return json(page([])); });
  assert.equal(calls, 1); assert.deepEqual(result.videos, []);
});

test('unknown, live, short and overlong videos are excluded rather than inventing eligibility', async () => {
  const ids = [id, other, '12345678901', '12345678902', '12345678903'];
  const items = ids.map(item);
  items[0].contentDetails.duration = 'unknown'; items[1].snippet.liveBroadcastContent = 'live';
  items[2].contentDetails.duration = 'PT3M'; items[3].contentDetails.duration = 'PT3H';
  let calls = 0;
  const result = await run(async () => json(++calls === 1 ? page(ids) : { items }));
  assert.deepEqual(result.videos.map(v => v.video_id), ['12345678903']);
});

test('unrequested or duplicate metadata IDs fail closed', async () => {
  for (const items of [[item(other)], [item(), item()]]) {
    let calls = 0;
    await assert.rejects(run(async () => json(++calls === 1 ? page([id]) : { items })), { code: 'INVALID_RESPONSE' });
    assert.equal(calls, 2);
  }
});

test('HTTP failures and network errors cannot echo tokens and are never retried', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(run(async () => { calls++; return new Response(token, { status }); }), error => {
      assert.ok(!String(error).includes(token)); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(run(async () => { throw new Error(token); }), { code: 'REQUEST_FAILED' });
});

test('wrong media types, malformed JSON, oversized and credential-reflecting bodies are rejected', async () => {
  const factories = [
    () => new Response('html'),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response(' '.repeat(2097153), { headers: { 'content-type': 'application/json' } }),
    () => json({ ...page([]), echo: token }),
    () => new Response(JSON.stringify({ ...page([]), echo: token }).replace('TOKEN', '\\u0054OKEN'), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of factories) await assert.rejects(run(async () => response()), error => {
    assert.ok(!String(error).includes(token)); return true;
  });
});

test('request timeout aborts and cancellation before or between requests prevents further calls', async () => {
  await assert.rejects(run((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(token)));
  }), { timeoutMs: 5 }), { code: 'TIMEOUT' });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(run(() => assert.fail('must not call'), { signal: cancelled.signal }), { code: 'CANCELLED' });
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(run(async () => { calls++; controller.abort(); return json(page([id])); }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(calls, 1);
});

test('native Google auth requests only YouTube read-only and rejects missing scope or unsafe tokens', async () => {
  const api = result => ({ identity: { async getAuthToken(options) {
    assert.deepEqual(options, { interactive: true, enableGranularPermissions: true, scopes: [YOUTUBE_SCOPE] });
    return result;
  } } });
  assert.equal(await getGoogleToken(api({ token, grantedScopes: [YOUTUBE_SCOPE] }), true), token);
  for (const result of [{ token, grantedScopes: [] }, { token }, { token: '\r\ninvalid', grantedScopes: [YOUTUBE_SCOPE] }]) {
    await assert.rejects(getGoogleToken(api(result), true), { code: 'REQUIRED_SCOPE_MISSING' });
  }
  await assert.rejects(getGoogleToken({}, true), { code: 'BROWSER_AUTH_UNSUPPORTED' });
  await assert.rejects(getGoogleToken({ identity: { getAuthToken() { throw new Error(token); } } }, true), { code: 'GOOGLE_SIGN_IN_FAILED' });
});

test('invalid query or token makes no network request', async () => {
  for (const extra of [{ query: '' }, { query: 'q'.repeat(301) }, { token: '\r\ninvalid' }]) {
    await assert.rejects(run(() => assert.fail('must not call'), extra));
  }
});

test('browser adapter blocks unconfigured and Firefox clients and ignores late sign-in after cancel', async () => {
  const source = await buildBrowserScript('extension/live-browser.js');
  const make = (manifest, overrides = {}) => {
    const context = { chrome: { runtime: { getManifest: () => manifest, id: 'local-test-id' }, identity: { getAuthToken() {} } },
      AbortController, AbortSignal, setTimeout, clearTimeout, fetch: () => assert.fail('network must not run'), ...overrides };
    vm.runInNewContext(source, context);
    return context.MyTubeLive;
  };
  await assert.rejects(make({}).search('test'), { code: 'GOOGLE_SETUP_REQUIRED' });
  const withoutGoogle = make({}, { chrome: { runtime: { getManifest: () => ({}), id: 'local-test-id' } } });
  assert.equal(withoutGoogle.status().ready, true, 'Default web discovery does not need Google OAuth or identity');
  assert.equal(withoutGoogle.status().provider, 'chatgpt_web');
  const firefox = make({}, { chrome: undefined, browser: { runtime: { id: 'mytube@test.invalid', getManifest: () => ({ browser_specific_settings: { gecko: {} } }) } } });
  assert.equal(firefox.status().ready, true);
  assert.equal(firefox.status().provider, 'chatgpt_web');
  await assert.rejects(firefox.subscriptions(), { code: 'BROWSER_AUTH_UNSUPPORTED' });
  await assert.rejects(make({ browser_specific_settings: { gecko: {} } }).search('test'), { code: 'BROWSER_AUTH_UNSUPPORTED' });
  let finishAuth;
  const client = make({ oauth2: { client_id: 'public-id' } }, { chrome: { runtime: { getManifest: () => ({ oauth2: { client_id: 'public-id' } }), id: 'local-test-id' },
    identity: { getAuthToken: () => new Promise(resolve => { finishAuth = resolve; }) } } });
  const controller = new AbortController();
  const pending = client.search('test', controller.signal);
  controller.abort(); finishAuth({ token, grantedScopes: [YOUTUBE_SCOPE] });
  await assert.rejects(pending, { code: 'CANCELLED' });
});
