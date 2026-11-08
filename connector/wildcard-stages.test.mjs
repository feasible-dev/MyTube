import test from 'node:test';
import assert from 'node:assert/strict';
import { runWildcardStages } from './wildcard-stages.mjs';
import { createWildcardProgress } from './wildcard-progress.mjs';
import { createWildcardTask } from './wildcard-task.mjs';
import { videoReference } from '../extension/video-reference.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';
import { validateWildcardVideos } from '../extension/wildcard-discovery.mjs';

test('independent platform groups start together and retain grounded results if one group fails', async () => {
  const tasks = [], batches = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  const pending = runWildcardStages({ intention: 'Conversos', preferences: defaultPreferences(), signal: new AbortController().signal,
    publish: batch => batches.push(batch), run: async batch => {
      tasks.push(...batch.tasks); await held;
      const task = batch.tasks[1];
      task.observeEvent({ type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed', action: {
        query: 'site:rumble.com Conversos history', sources: [{ url: 'https://rumble.com/v12345-history.html', title: 'Conversos history' }],
      } } });
      throw Error('CHATGPT_TIMEOUT');
    } });
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks[0].build('test-model').tools[0].filters.allowed_domains, ['bitchute.com']);
  assert.deepEqual(tasks[1].build('test-model').tools[0].filters.allowed_domains, ['rumble.com']);
  assert.deepEqual(tasks[2].build('test-model').tools[0].filters.allowed_domains, ['rutube.ru']);
  assert.ok(tasks[3].build('test-model').tools[0].filters.allowed_domains.includes('odysee.com'));
  assert.ok(tasks[3].build('test-model').tools[0].filters.allowed_domains.includes('archive.org'));
  release(); const final = await pending;
  assert.equal(final.videos.length, 1); assert.equal(final.videos[0].platform, 'Rumble');
  assert.equal(batches[0].search_details[0].query, 'site:rumble.com Conversos history');
});

test('fatal failures and cancellation are never hidden by partial wildcard results', async () => {
  for (const message of ['CHATGPT_LIMIT_REACHED', 'CHATGPT_FAILED', 'CLEANUP_REQUIRED']) {
    await assert.rejects(runWildcardStages({ intention: 'History', preferences: defaultPreferences(),
      run: async batch => { batch.tasks[0].accept({ videos: [{ video_id: 'abcdefghijk' }], searches: 1 }); throw Error(message); } }), { message });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runWildcardStages({ signal: controller.signal, run: () => assert.fail('cancelled') }), /CANCELLED/);
});

test('platform lanes reject out-of-lane citations and Rutube accepts only canonical video pages', () => {
  const url = 'https://rutube.ru/video/4a198a58672f4b563d8e4d23dae1f40b/';
  assert.equal(videoReference(url + '?tracking=1').url, url);
  for (const bad of ['https://rutube.ru/channel/123', 'https://rutube.ru/video/nope', 'https://rutube.ru.evil.example/video/4a198a58672f4b563d8e4d23dae1f40b/']) assert.equal(videoReference(bad), null);
  const batches = [], task = createWildcardTask('Conversos', () => {}, defaultPreferences(), b => batches.push(b), [], ['Rumble', 'BitChute', 'Rutube']);
  task.observeEvent({ type: 'response.output_item.done', item: { type: 'web_search_call', action: { sources: [
    { url: 'https://vimeo.com/12345', title: 'Vimeo result outside lane' }, { url, title: 'History on Rutube' },
  ] } } });
  assert.equal(batches[0].picks.length, 1); assert.equal(batches[0].picks[0].platform, 'Rutube');
});

test('fast general sources leave room for slower alternative sources and unused space fills at completion', async () => {
  const pick = (url, title) => ({ ...videoReference(url), source_url: videoReference(url).url, title, why: 'History connection' });
  const core = [1, 2, 3].map(i => pick(`https://vimeo.com/${i}`, `Vimeo history ${i}`))
    .concat([1, 2, 3].map(i => pick(`https://dailymotion.com/video/x${i}`, `Dailymotion history ${i}`)));
  const alternative = [1, 2, 3].map(i => pick(`https://rumble.com/v${i}-history.html`, `Rumble history ${i}`));
  const batches = [], feed = createWildcardProgress({ preview: async v => ({ thumbnail_url: ({ Vimeo: 'https://i.vimeocdn.com/video/123.jpg', Dailymotion: 'https://s1.dmcdn.net/v/123', Rumble: 'https://1a-1791.com/video/123.jpg' })[v.platform] }), signal: new AbortController().signal, publish: b => batches.push(b) });
  feed.observe({ picks: core, searches: 2 }); assert.equal((await feed.counts()).wildcard, 5);
  feed.observe({ picks: alternative, searches: 4 }); assert.equal((await feed.counts()).wildcard, 8);
  const final = await feed.finish([...core, ...alternative]);
  assert.equal(final.filter(v => v.platform === 'Rumble').length, 3);
  validateWildcardVideos({ videos: final, searches: 4 });
  for (const batch of batches) validateWildcardVideos(batch);
  const only = createWildcardProgress({ preview: async v => ({ thumbnail_url: ({ Vimeo: 'https://i.vimeocdn.com/video/123.jpg', Dailymotion: 'https://s1.dmcdn.net/v/123', Rumble: 'https://1a-1791.com/video/123.jpg' })[v.platform] }), signal: new AbortController().signal, publish: () => {} });
  only.observe({ picks: core }); await only.counts(); assert.equal((await only.finish(core)).length, 6);
});
