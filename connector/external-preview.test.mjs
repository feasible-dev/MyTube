import test from 'node:test';
import assert from 'node:assert/strict';
import { externalPreview } from './external-preview.mjs';
import { createWildcardProgress } from './wildcard-progress.mjs';
import { videoReference } from '../extension/video-reference.mjs';

const video = url => ({ ...videoReference(url), source_url: videoReference(url).url });

test('Odysee video references exclude channels; Archive previews require a movie item', async () => {
  const odysee = video('https://odysee.com/@creator:1/example-video:a');
  assert.equal(odysee.platform, 'Odysee');
  assert.equal(videoReference('https://odysee.com/@creator:1'), null);
  assert.equal(videoReference('https://odysee.com.evil.example/@creator:1/example-video:a'), null);
  const archive = video('https://archive.org/details/example-film');
  for (const mediatype of ['texts', 'audio', 'collection']) {
    assert.deepEqual(await externalPreview(archive, undefined, async () => new Response(JSON.stringify({ metadata: { mediatype } }),
      { headers: { 'content-type': 'application/json' } })), { preview_unavailable: true });
  }
  assert.deepEqual(await externalPreview(archive, undefined, async () => new Response(JSON.stringify({ metadata: { mediatype: 'movies', runtime: '9:15' } }),
    { headers: { 'content-type': 'application/json' } })), { thumbnail_url: 'https://archive.org/services/img/example-film', duration_seconds: 555, duration_source: 'provider_metadata' });
});
test('Rumble uses public oEmbed instead of its redirecting watch page; Dailymotion API supplies image and duration', async () => {
  for (const [url, host, path, image, duration] of [
    ['https://rumble.com/v7a37su-dont-panic-a-guide-to-artificial-intelligence.html', 'rumble.com', '/api/Media/oembed.json', 'https://hugh.cdn.rumble.cloud/video/image.jpg', 3710],
    ['https://www.dailymotion.com/video/xagmwgm', 'api.dailymotion.com', '/video/xagmwgm', 'https://s1.dmcdn.net/v/image', 1696],
    ['https://rutube.ru/video/79157198f0661646f612450e7b2425ff/', 'rutube.ru', '/api/video/79157198f0661646f612450e7b2425ff/', 'https://pic.rtbcdn.ru/video/2025-03-23/df/84/df84e2554b9d8534e0e265f1e7845ad8.jpg', 2581],
  ]) {
    let calls = 0;
    const result = await externalPreview(video(url), undefined, async (target, options) => {
      calls++; const endpoint = new URL(target);
      assert.equal(endpoint.hostname, host); assert.equal(endpoint.pathname, path);
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      return new Response(JSON.stringify({ thumbnail_url: image, duration, html: '<iframe>ignored</iframe>' }), { headers: { 'content-type': 'application/json' } });
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { thumbnail_url: image, duration_seconds: duration, duration_source: 'provider_metadata' });
  }
});

test('deleted Dailymotion videos are distinguished from temporary preview failures', async () => {
  const row = video('https://www.dailymotion.com/video/x9jmfoy');
  const result = await externalPreview(row, undefined, async target => target.startsWith('https://api.')
    ? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    : new Response('Invalid video URL.', { headers: { 'content-type': 'text/html' } }));
  assert.deepEqual(result, { preview_unavailable: true });
  assert.deepEqual(await externalPreview(row, undefined, async () => new Response('', { status: 503 })), {});
});

test('Dailymotion falls back to oEmbed when the public metadata API is unavailable', async () => {
  const hosts = [];
  const result = await externalPreview(video('https://www.dailymotion.com/video/xagmwgm'), undefined, async target => {
    const host = new URL(target).hostname; hosts.push(host);
    if (host === 'api.dailymotion.com') return new Response('', { status: 503 });
    return new Response(JSON.stringify({ thumbnail_url: 'https://s1.dmcdn.net/v/image' }), { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(hosts, ['api.dailymotion.com', 'www.dailymotion.com']);
  assert.equal(result.thumbnail_url, 'https://s1.dmcdn.net/v/image');
});
test('provider previews use bounded fixed endpoints and reject untrusted image hosts', async () => {
  for (const [url, image, host] of [
    ['https://vimeo.com/123', 'https://i.vimeocdn.com/video/123.jpg', 'vimeo.com'],
    ['https://dailymotion.com/video/x123', 'https://s2.dmcdn.net/v/123', 'www.dailymotion.com'],
    ['https://rutube.ru/video/' + 'a'.repeat(32), 'https://pic.rutube.ru/video/123.jpg', 'rutube.ru'],
  ]) {
    const row = video(url);
    const fetchImpl = async (target, options) => {
      assert.equal(new URL(target).hostname, host);
      assert.equal(new URL(target).searchParams.get('url'), row.url);
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      return new Response(JSON.stringify({ thumbnail_url: image, html: '<script>bad()</script>' }), { headers: { 'content-type': 'application/json' } });
    };
    assert.deepEqual(await externalPreview(row, undefined, fetchImpl), { thumbnail_url: image });
  }
  for (const thumbnail_url of ['http://i.vimeocdn.com/a', 'https://evil.example/a', 'https://i.vimeocdn.com.evil.example/a']) {
    assert.deepEqual(await externalPreview(video('https://vimeo.com/123'), undefined, async () => new Response(JSON.stringify({ thumbnail_url }), { headers: { 'content-type': 'application/json' } })), {});
  }
  assert.deepEqual(await externalPreview(video('https://vimeo.com/123'), undefined, async () => { throw Error('offline'); }), {});
});

test('external cards wait for a provider preview before publication', async () => {
  let release; const batches = [];
  const feed = createWildcardProgress({ signal: new AbortController().signal,
    publish: batch => batches.push(structuredClone(batch)), preview: () => new Promise(resolve => { release = resolve; }) });
  const pick = { ...video('https://vimeo.com/123'), title: 'Film discussion', why: 'A related perspective' };
  feed.observe({ picks: [pick] }); await new Promise(setImmediate);
  assert.equal(batches.length, 0);
  release({ thumbnail_url: 'https://i.vimeocdn.com/video/123.jpg' });
  const rows = await feed.finish([pick]);
  assert.equal(rows.length, 1); assert.equal(rows[0].thumbnail_url, 'https://i.vimeocdn.com/video/123.jpg');
  assert.equal(batches.at(-1).videos[0].video_id, batches[0].videos[0].video_id);
});

test('canonical alternative-platform pages supply only allowed preview images', async () => {
  for (const [url, image] of [
    ['https://rumble.com/v123-film.html', 'https://1a-1791.com/video/test.jpg'],
    ['https://www.bitchute.com/video/abcd', 'https://seed123.bitchute.com/image/test.jpg'],
  ]) {
    assert.deepEqual(await externalPreview(video(url), undefined, async (target, options) => {
      assert.equal(target, video(url).url); assert.equal(options.redirect, 'error');
      return new Response(`<meta content="${image}" property="og:image">`, { headers: { 'content-type': 'text/html' } });
    }), { thumbnail_url: image });
  }
});

test('deleted or unresolvable external videos never become clickable discovery cards', async () => {
  for (const status of [404, 410]) {
    assert.deepEqual(await externalPreview(video('https://vimeo.com/123'), undefined,
      async () => new Response('', { status })), { preview_unavailable: true });
  }
  const picks = [1, 2, 3].map(id => ({ ...video(`https://vimeo.com/${id}`), title: `Video ${id}`, why: 'Related' }));
  const batches = [];
  const feed = createWildcardProgress({ signal: new AbortController().signal, publish: b => batches.push(b),
    preview: async v => v.source_url.endsWith('/1') ? { preview_unavailable: true } :
      v.source_url.endsWith('/2') ? {} : { thumbnail_url: 'https://i.vimeocdn.com/video/3.jpg' } });
  feed.observe({ picks });
  assert.deepEqual((await feed.finish(picks)).map(v => v.title), ['Video 3']);
  assert.ok(batches.every(b => b.videos.every(v => v.title === 'Video 3')));
});

test('indexed BitChute aliases normalize to a fixed public watch page', () => {
  for (const host of ['old.bitchute.com', 'api.bitchute.com', 'www.bitchute.com']) {
    assert.equal(videoReference(`https://${host}/video/abcd/?tracking=1`).url, 'https://www.bitchute.com/video/abcd');
  }
  assert.equal(videoReference('https://old.bitchute.com.evil.example/video/abcd'), null);
});

test('YouTube alone can fill all eight exploration slots with verified different creators', async () => {
  const picks = Array.from({ length: 8 }, (_, i) => ({ video_id: `abcdefghij${i}`, source_url: `https://www.youtube.com/watch?v=abcdefghij${i}`, title: `Topic ${i}` }));
  const feed = createWildcardProgress({ signal: new AbortController().signal, publish() {},
    metadata: async ([p]) => [{ ...p, channel: p.video_id, source: 'youtube_web', discovery_stream: 'wildcard' }] });
  feed.observe({ picks });
  assert.equal((await feed.finish(picks)).length, 8);
});
