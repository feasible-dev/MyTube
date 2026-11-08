import test from 'node:test';
import assert from 'node:assert/strict';
import { createWildcardTask } from './wildcard-task.mjs';
import { videoReference } from '../extension/video-reference.mjs';
import { defaultPreferences, validatePreferences, editorialInstructions } from '../extension/preferences.mjs';
import { validateWildcardVideos } from '../extension/wildcard-discovery.mjs';
import { startConnector, EXTENSION_ID } from './server.mjs';
import { createWildcardProgress } from './wildcard-progress.mjs';

const urls = ['https://www.youtube.com/watch?v=abcdefghijk', 'https://vimeo.com/123456', 'https://rumble.com/v12345-navigation.html', 'https://www.bitchute.com/video/abc123', 'https://www.dailymotion.com/video/x12345'];
const source = url => ({ url, title: `Navigation film on ${videoReference(url).platform}` });
const response = videos => ({ status: 'completed', model: 'test-model', output: [
  { type: 'web_search_call', status: 'completed', action: { sources: urls.map(source) } },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ videos }) }] },
] });

test('platform limits apply to streamed, final and follow-up wildcard selections', () => {
  const links = Array.from({ length: 7 }, (_, i) => `https://vimeo.com/${100000 + i}`);
  const values = links.map(url => ({ url, why: 'Astronomy connection' }));
  const payload = response(values); payload.output[0].action.sources = links.map(source);
  const batches = [], task = createWildcardTask('Aboriginal astronomy', () => {}, defaultPreferences(), batch => batches.push(batch));
  task.observeEvent({ type: 'response.output_item.done', item: payload.output[0] });
  task.observeEvent({ type: 'response.output_text.delta', delta: JSON.stringify({ videos: values }) });
  assert.equal(batches.flatMap(b => b.picks).length, 3);
  const final = task.validate(payload, 'test-model'); assert.equal(final.videos.length, 3);
  const followup = createWildcardTask('Aboriginal astronomy', () => {}, defaultPreferences(), () => {}, final.videos.map(v => v.video_id));
  assert.throws(() => followup.validate(payload, 'test-model'), /WEB_SEARCH_NO_SOURCED_VIDEOS/);
});
test('wildcards accept supported watch URLs only, grounded in tool sources; no guessed links', () => {
  const task = createWildcardTask('Pacific settlement', () => {}, defaultPreferences());
  const videos = task.validate(response([...urls, 'https://vimeo.com/999999', 'https://evil.example/watch?v=abcdefghijk'].map(url => ({ url, why: 'Navigation connection' }))), 'test-model').videos;
  assert.equal(videos.length, 5);
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.example/watch?v=abcdefghijk', 'https://user@vimeo.com/123456', 'https://vimeo.com:444/123456', 'https://rumble.com/user/name', 'https://www.bitchute.com/channel/name', 'https://www.youtube.com/results?search_query=film']) assert.equal(videoReference(url), null);
  assert.equal(videoReference('https://youtu.be/abcdefghijk?t=4').video_id, 'abcdefghijk');
  assert.equal(videoReference('https://vimeo.com/123456?tracking=test').url, 'https://vimeo.com/123456');
});
test('real watch-page sources stream without waiting for the model to repeat every URL', () => {
  const batches = [], task = createWildcardTask('Pacific', () => {}, defaultPreferences(), batch => batches.push(batch));
  task.observeEvent({ type: 'response.output_text.delta', delta: '{"videos":[{"url":"https://vimeo.com/123456","why":"navigation"}' });
  assert.equal(batches.length, 0);
  task.observeEvent({ type: 'response.output_item.done', item: response([]).output[0] });
  assert.equal(batches.length, 1); assert.equal(batches[0].picks.length, 5);
  assert.equal(batches[0].picks.find(p => p.platform === 'Vimeo').title, source(urls[1]).title);
  assert.equal(task.validate(response([{ url: urls[1], why: 'Navigation connection' }]), 'test-model').videos.length, 5);
});

test('underfilled follow-ups target platforms absent from the first round', () => {
  const body = createWildcardTask('Conversos', () => {}, defaultPreferences(), () => {}, ['abcdefghijk']).build('test-model');
  assert.equal(body.tools[0].filters.allowed_domains.includes('youtube.com'), false);
  assert.equal(body.tools[0].filters.allowed_domains.includes('bitchute.com'), true);
  assert.equal(body.tools[0].filters.allowed_domains.includes('rumble.com'), true);
});

test('wildcard progress counts usable diversified cards rather than raw collected links', async () => {
  const picks = Array.from({ length: 4 }, (_, i) => {
    const ref = videoReference(`https://www.youtube.com/watch?v=${String(i).padStart(11, '0')}`);
    return { ...ref, source_url: ref.url, title: `History ${i}`, stream: 'wildcard', why: 'Related history' };
  });
  const feed = createWildcardProgress({ preview: async () => ({}), signal: new AbortController().signal, publish: () => {}, metadata: async ([pick]) => [{
    ...pick, channel: 'Same creator', source: 'youtube_web', discovery_stream: 'wildcard',
  }] });
  feed.observe({ picks, searches: 1 });
  assert.deepEqual(await feed.counts(), { wildcard: 2 });
  assert.equal((await feed.finish(picks)).length, 2); feed.close();
});
test('five-level choices are explicit and alternative setting changes search instructions', () => {
  assert.equal(validatePreferences({ ...defaultPreferences(), politics: 80, perspective: 19 }).politics, 75);
  assert.match(editorialInstructions({ politics: 75, perspective: 100 }), /4 — Center-right/);
  const body = createWildcardTask('Pacific', () => {}, { ...defaultPreferences(), perspective: 100 }).build('test-model');
  assert.match(body.instructions, /prioritize those searches/);
  assert.match(body.instructions, /Rumble and BitChute/);
  assert.match(body.instructions, /5 — Alternative/);
  assert.equal(body.tools[0].filters.allowed_domains.includes('bitchute.com'), true);
});
test('protected wildcard endpoint streams external cards without fetching arbitrary pages', async () => {
  const pick = { ...videoReference(urls[1]), source_url: urls[1], title: 'Pacific navigation', stream: 'wildcard', why: 'Ocean settlement' };
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const server = await startConnector({ port: 0, signOut: async () => {}, preview: async () => ({ thumbnail_url: 'https://i.vimeocdn.com/video/123.jpg' }), metadata: async () => assert.fail('External URLs must not reach YouTube metadata'),
    planner: async (_text, _signal, _auth, _prefs, _recovery, mode, publish) => {
      assert.equal(mode, 'wildcard'); publish({ picks: [pick], searches: 1 }); await held; return { videos: [pick], searches: 1 };
    } });
  try {
    const result = await fetch(`http://127.0.0.1:${server.port}/wildcard-discover`, { method: 'POST', headers: {
      Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', Accept: 'application/x-ndjson',
    }, body: JSON.stringify({ intention: 'Pacific' }), signal: AbortSignal.timeout(3000) });
    const reader = result.body.getReader(), first = await reader.read();
    const value = JSON.parse(new TextDecoder().decode(first.value).trim());
    assert.equal(value.type, 'progress'); assert.equal(validateWildcardVideos(value).videos[0].platform, 'Vimeo');
    finish(); let tail = ''; while (true) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
    assert.equal(JSON.parse(tail.trim()).type, 'result');
  } finally { finish(); await server.close(); }
});
