import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebDiscoveryTask, validateWebDiscovery, youtubeId } from './web-task.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';
const id = 'abcdefghijk';

test('originality controls the related mix and endpoint labels while DIRECT stays on topic', async () => {
  for (const [originality, target, allowed] of [[0, 0, ['adjacent']], [50, 4, ['adjacent', 'wildcard']], [100, 8, ['wildcard']]]) {
    const prefs = { ...defaultPreferences(), originality };
    const task = createWebDiscoveryTask('Yugoslavia', () => {}, prefs, undefined, () => {}, 'related');
    const body = task.build('test');
    assert.deepEqual(body.text.format.schema.properties.videos.items.properties.stream.enum, allowed);
    assert.match(body.instructions, new RegExp(`Target ${target} WILDCARD and ${8 - target} ADJACENT`));
    assert.deepEqual(createWebDiscoveryTask('Yugoslavia', () => {}, prefs, undefined, () => {}, 'direct').build('test').text.format.schema.properties.videos.items.properties.stream.enum, ['direct']);
    if (originality !== 50) {
      const invalid = response();
      const content = invalid.output[1].content[0];
      const data = JSON.parse(content.text); data.videos[0].stream = originality ? 'adjacent' : 'wildcard'; content.text = JSON.stringify(data);
      await assert.rejects(task.validate(invalid, 'test'), { message: 'WEB_SEARCH_NO_SOURCED_VIDEOS' });
    }
  }
});
const response = () => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { sources: [{ url: `https://www.youtube.com/watch?v=${id}` }] } },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ videos: [
    { url: `https://www.youtube.com/watch?v=${id}`, stream: 'direct', why: 'Relevant source' }, { url: 'https://www.youtube.com/watch?v=lmnopqrstuv', stream: 'wildcard', why: 'Not sourced' },
  ] }) }] },
] });
test('web discovery accepts only sourced watch URLs and rejects model-only IDs', () => {
  assert.deepEqual(validateWebDiscovery(response(), 'test').videos.map(v => v.video_id), [id]);
  const r = response(); r.output.shift();
  assert.throws(() => validateWebDiscovery(r, 'test'));
  const empty = response(); empty.output[0].action.sources = [];
  assert.throws(() => validateWebDiscovery(empty, 'test'), { message: 'WEB_SEARCH_NO_SOURCED_VIDEOS' });
  for (const u of [`https://youtube.com.evil.test/watch?v=${id}`, `https://youtube.com@evil.test/watch?v=${id}`, `http://youtube.com/watch?v=${id}`, `https://www.youtube.com/playlist?list=${id}`]) assert.equal(youtubeId(u), null);
});
test('web discovery is bounded, preserves user input as data and requests real web sources', () => {
  const task = createWebDiscoveryTask('Synthetic history interest', () => {});
  const body = task.build('available-model');
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.max_tool_calls, undefined);
  for (let i = 0; i < 6; i++) task.observeEvent({ type: 'response.output_item.added', item: { type: 'web_search_call' } });
  assert.throws(() => task.observeEvent({ type: 'response.output_item.added', item: { type: 'web_search_call' } }), { message: 'WEB_SEARCH_LIMIT_REACHED' });
  assert.equal(body.input[0].content, 'Synthetic history interest');
  assert.equal(body.tools[0].type, 'web_search'); assert.equal(body.tool_choice, 'required');
  assert.deepEqual(body.include, ['web_search_call.action.sources']);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 16384);
});

test('streamed completed items supply sources when the OAuth final envelope omits output', async () => {
  const task = createWebDiscoveryTask('Maya archaeology', () => {});
  for (const item of response().output) task.observeEvent({ type: 'response.output_item.done', item });
  assert.deepEqual((await task.validate({ status: 'completed', output: [] }, 'test')).videos.map(v => v.video_id), [id]);
});

test('web source events and grounded output fragments can publish before final output', () => {
  const updates = [];
  const task = createWebDiscoveryTask('Maya archaeology', () => {}, undefined, undefined, value => updates.push(value));
  task.observeEvent({ type: 'response.output_item.added', item: { type: 'web_search_call' } });
  task.observeEvent({ type: 'response.output_item.done', item: response().output[0] });
  assert.equal(updates[0].picks[0].video_id, id);
  const message = JSON.parse(response().output[1].content[0].text);
  const output = JSON.stringify(message);
  task.observeEvent({ type: 'response.output_text.delta', delta: output.slice(0, 22) });
  assert.equal(updates.length, 1);
  task.observeEvent({ type: 'response.output_text.delta', delta: output.slice(22) });
  assert.equal(updates.length, 2); assert.equal(updates[1].selected, true);
  assert.equal(updates[1].picks[0].video_id, id);
});
