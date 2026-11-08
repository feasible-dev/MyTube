import test from 'node:test';
import assert from 'node:assert/strict';
import { publicVideoMetadata } from './public-videos.mjs';
test('public video verification uses only fixed oEmbed origin and leaves unavailable facts unknown', async () => {
  const rows = await publicVideoMetadata([{ video_id: 'abcdefghijk', stream: 'direct', why: 'Evidence' }], undefined, async (url, init) => {
    const u = new URL(url); assert.equal(u.origin, 'https://www.youtube.com'); assert.equal(u.pathname, '/oembed');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.headers.Authorization, undefined);
    return new Response(JSON.stringify({ provider_name: 'YouTube', title: 'Maya archaeology', author_name: 'Example', html: '<script>bad</script>' }), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal(rows[0].duration_seconds, null); assert.equal(rows[0].views, null); assert.equal(rows[0].published_at, null);
  assert.equal(rows[0].source, 'youtube_web'); assert.ok(!JSON.stringify(rows).includes('<script>'));
});
test('unavailable, oversized and invalid metadata cannot become tiles', async () => {
  const pick = [{ video_id: 'abcdefghijk', stream: 'direct' }];
  for (const response of [() => new Response('', { status: 404 }), () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{"provider_name":"Other"}', { headers: { 'content-type': 'application/json' } })]) {
    assert.deepEqual(await publicVideoMetadata(pick, undefined, async () => response()), []);
  }
  await assert.rejects(publicVideoMetadata([{ video_id: '../evil' }]), { message: 'INVALID_GENERATED_RESPONSE' });
});
