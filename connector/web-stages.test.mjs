import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebStages } from './web-stages.mjs';

test('each column gets its own selection, publishes immediately and keeps closest duplicate', async () => {
  const updates = [], intention = 'Maya history';
  const result = await runWebStages({ intention, now: (() => { let calls = 0; return () => calls++ ? 190000 : 0; })(), publish: value => updates.push(value), run: async batch => {
    assert.equal(batch.tasks.length, 2);
    for (const [i, task] of batch.tasks.entries()) {
      const body = task.build('test-model');
      assert.equal(body.input[0].content, intention);
      assert.equal(body.text.format.schema.properties.videos.maxItems, 12);
      assert.deepEqual(body.text.format.schema.properties.videos.items.properties.stream.enum, [['direct'], ['adjacent', 'wildcard']][i]);
      assert.match(body.instructions, /Viewing languages: English/);
      await task.accept({ videos: [{ video_id: 'abcdefghijk', stream: i ? 'adjacent' : 'direct', why: 'A connection' }, ...(i ? [{ video_id: 'lmnopqrstuv', stream: 'wildcard', why: 'Unexpected' }] : [])], searches: 2 });
      assert.equal(updates.length, i + 1);
    }
  } });
  assert.equal(result.searches, 4);
  assert.deepEqual(result.videos.map(v => v.stream), ['direct', 'wildcard']);
});

test('usage failures do not trigger another batch', async () => {
  let calls = 0;
  await assert.rejects(runWebStages({ intention: 'China', run: async () => { calls++; throw Error('CHATGPT_LIMIT_REACHED'); } }), { message: 'CHATGPT_LIMIT_REACHED' });
  assert.equal(calls, 1);
});


test('underfilled columns get bounded new searches with previous IDs excluded', async () => {
  let calls = 0;
  const result = await runWebStages({ intention: 'Maya history', run: async batch => {
    calls++;
    for (const [i, task] of batch.tasks.entries()) {
      const body = task.build('test');
      if (calls > 1) assert.match(body.instructions, /MUST be excluded: 00000000000/);
      await task.accept({ videos: [{ video_id: String((calls - 1) * 3 + i).padStart(11, '0'), stream: ['direct', 'adjacent', 'wildcard'][i], why: 'Connection' }], searches: 2 });
    }
  } });
  assert.equal(calls, 6); assert.equal(result.videos.length, 12); assert.equal(result.searches, 24);
});

test('refill uses verified counts, skips filled columns and continues past the old 75-second cutoff', async () => {
  let calls = 0;
  const ready = { direct: 8, adjacent: 2, wildcard: 0 };
  await runWebStages({ intention: 'History', now: () => calls ? 90000 : 0, getCounts: () => ready, run: async batch => {
    calls++;
    const directions = batch.tasks.map(task => task.build('test').text.format.schema.properties.videos.items.properties.stream.enum[0]);
    assert.deepEqual(directions, ['adjacent']);
    for (const [i, task] of batch.tasks.entries()) {
      const stream = directions[i];
      assert.match(task.build('test').instructions, /still needs (6|4) usable videos/);
      await task.accept({ videos: [{ video_id: String(calls * 10 + i).padStart(11, '0'), stream, why: 'Different angle' }], searches: 2 });
    }
    ready.adjacent = 4;
    if (calls === 2) ready.wildcard = 4;
  } });
  assert.equal(calls, 2);
});

test('timeout preserves sourced streamed picks and excludes them on the next wave', async () => {
  let calls = 0;
  const result = await runWebStages({ intention: 'History', now: () => calls > 1 ? 190000 : 0, run: async batch => {
    calls++;
    if (calls === 1) {
      const task = batch.tasks[0];
      task.observeEvent({ type: 'response.output_item.added', item: { type: 'web_search_call' } });
      task.observeEvent({ type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://www.youtube.com/watch?v=abcdefghijk' }] } } });
      task.observeEvent({ type: 'response.output_text.delta', delta: JSON.stringify({ videos: [{ url: 'https://www.youtube.com/watch?v=abcdefghijk', stream: 'direct', why: 'History' }] }) });
      throw Error('CHATGPT_TIMEOUT');
    }
    assert.match(batch.tasks[0].build('test').instructions, /MUST be excluded: abcdefghijk/);
    await batch.tasks[0].accept({ videos: [{ video_id: 'lmnopqrstuv', stream: 'direct', why: 'Another angle' }], searches: 2 });
  } });
  assert.equal(calls, 2);
  assert.deepEqual(result.videos.map(v => v.video_id), ['abcdefghijk', 'lmnopqrstuv']);
});
