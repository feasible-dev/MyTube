import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveSearchError } from './youtube-live.mjs';
import { discoverLocalYouTube } from './local-youtube.mjs';
import { defaultPreferences } from './preferences.mjs';
import { selectSearchColumns } from '../poc/model.mjs';
import { conciseQuickQuery } from './quick-relevance.mjs';
const plan = { queries: ['direct', 'adjacent', 'wildcard'].flatMap(stream => Array.from({ length: 4 }, (_, i) => ({ stream, query: `${stream} archaeology ${i}`, why: 'Historical connection' }))) };
const result = id => ({ videos: [{ video_id: id, title: 'Maya archaeology', channel: id, source: 'youtube_live', duration_seconds: 2100 }], requests: 2, search_results: 50 });

test('adaptive searches target the emptiest selectable columns and append new angles', async () => {
  const calls = [], updates = [];
  const final = await discoverLocalYouTube({ intention: 'Maya', preparedPlan: plan,
    onProgress: batch => updates.push(structuredClone(batch)),
    search: async query => {
      calls.push(query);
      const count = calls.length === 1 ? 8 : calls.length === 2 ? 4 : calls.length === 3 ? 2 : 8;
      return { requests: 2, search_results: count, videos: Array.from({ length: count }, (_, i) => {
        const id = String(calls.length * 100 + i).padStart(11, '0');
        return { ...result(id).videos[0], title: `Video ${id}` };
      }) };
    } });
  assert.deepEqual(calls.slice(3), ['wildcard archaeology 2', 'adjacent archaeology 2']);
  assert.equal(final.youtube_searches, 5);
  assert.equal(selectSearchColumns(final.videos, true).related.length, 8);
  assert.equal(selectSearchColumns(final.videos, true).wildcard.length, 8);
  assert.ok(updates.slice(2).every(b => b.streams.direct.videos.length === 8));
  assert.equal(final.streams.wildcard.videos[0].video_id, '00000000300');
});

test('full web discoveries avoid a quota top-up and quota errors stop additional searches', async () => {
  for (const quotaError of [false, true]) {
    let calls = 0;
    const pool = offset => Array.from({ length: 8 }, (_, i) => {
      const id = String(offset + i).padStart(11, '0');
      return { ...result(id).videos[0], title: `Video ${id}` };
    });
    const final = await discoverLocalYouTube({ intention: 'Maya', preparedPlan: plan,
      search: async () => {
        calls++;
        if (quotaError && calls === 2) throw new LiveSearchError('QUOTA_EXCEEDED');
        return { requests: 1, search_results: 8, videos: calls === 3 ? [] : pool(calls * 100) };
      }, wildcards: async () => ({ videos: pool(400).map(v => ({ ...v, discovery_stream: 'wildcard' })) }) });
    assert.equal(calls, quotaError ? 2 : 3);
    assert.equal(final.warning, quotaError ? 'QUOTA_EXCEEDED' : undefined);
  }
});

test('cancelling a top-up prevents the fifth call', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(discoverLocalYouTube({ intention: 'Maya', preparedPlan: plan, signal: controller.signal,
    search: async () => { if (++calls === 4) controller.abort(); return result('abcdefghijk'); } }), { code: 'CANCELLED' });
  assert.equal(calls, 4);
});

test('exploration API keeps twenty candidates and survives a failed web lane', async () => {
  const calls = [];
  const final = await discoverLocalYouTube({ intention: 'Maya archaeology', preparedPlan: plan,
    search: async query => {
      calls.push(query);
      const group = query.startsWith('wildcard') ? query.endsWith('0') ? 100 : 110 : query.startsWith('adjacent') ? 200 : 300;
      return { requests: 2, search_results: 10, videos: Array.from({ length: 20 }, (_, i) => ({
        ...result(String(group + i).padStart(11, '0')).videos[0], title: `Film ${group + i}`,
      })) };
    }, wildcards: async () => { throw new LiveSearchError('WEB_SEARCH_NO_SOURCED_VIDEOS'); } });
  assert.equal(calls.length, 3);
  assert.equal(final.streams.wildcard.videos.length, 20);
  assert.equal(final.streams.wildcard.status, 'complete');
  assert.equal(final.streams.wildcard.web_error, 'WEB_SEARCH_NO_SOURCED_VIDEOS');
  assert.equal(final.warning, undefined);
  assert.equal(selectSearchColumns(final.videos, true, 24).wildcard.length, 20);
});

test('late web snapshots cannot erase API discoveries or their diagnostics', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const pending = discoverLocalYouTube({ intention: 'Maya', preparedPlan: plan,
    search: async query => result(query.startsWith('wildcard') ? 'abcdefghijk' : 'lmnopqrstuv'),
    wildcards: async (_signal, publish) => {
      await held;
      const batch = { videos: [{ video_id: 'web:https://vimeo.com/123', source: 'external_web', discovery_stream: 'wildcard' }],
        search_details: [{ query: 'site:vimeo.com navigation', platforms: ['Vimeo'] }] };
      publish(batch); publish(batch); return batch;
    } });
  await new Promise(setImmediate); release();
  const final = await pending;
  assert.deepEqual(final.streams.wildcard.videos.map(v => v.video_id), ['abcdefghijk', 'web:https://vimeo.com/123']);
  assert.equal(final.streams.wildcard.searches.length, 2);
});

test('cancellation between exploratory API queries stops the remaining queue', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(discoverLocalYouTube({ intention: 'Maya', preparedPlan: plan, signal: controller.signal,
    search: async () => { if (++calls === 2) controller.abort(); return result('abcdefghijk'); } }), { code: 'CANCELLED' });
  assert.equal(calls, 2);
});

test('multiword film results exclude partial-title matches before planning completes', async () => {
  let release;
  const updates = [], held = new Promise(resolve => { release = resolve; });
  const titles = ['The Parallax Code', 'Parallax Animation with 3D Camera', 'LEGION: Dawn of Empire',
    'What is Stereoscopic Vision', 'The Clockmaker', 'The Parallax View: a critical analysis'];
  const pending = discoverLocalYouTube({ intention: "J'aimerais en apprendre sur le film The Parallax View.", plan: () => held,
    onProgress: batch => updates.push(structuredClone(batch)), wildcards: async () => ({ videos: [] }),
    search: async query => ({ requests: 1, search_results: titles.length,
      videos: query === 'film The Parallax View' ? titles.map((title, i) => ({ ...result(String(i).padStart(11, '0')).videos[0], title })) : [] }) });
  await new Promise(setImmediate);
  try { assert.deepEqual(updates[0].streams.direct.videos.map(v => v.title), [titles[5]]); }
  finally { release({ ...plan, direct_subjects: ['The Parallax View'] }); await pending; }
});

test('empty columns receive at most two single-angle top-ups', async () => {
  const calls = [];
  const final = await discoverLocalYouTube({ intention: 'The Parallax View', preparedPlan: plan,
    search: async query => { calls.push(query); return { videos: [], requests: 1, search_results: 0 }; } });
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(0, 3).every(q => q.includes(' | ')));
  assert.deepEqual(calls.slice(3), ['direct archaeology 2', 'adjacent archaeology 2']);
  assert.equal(final.youtube_searches, 5);
  assert.equal(final.streams.direct.videos.length, 0);
});

test('long named-subject requests publish the first API page while the planner is still pending', async () => {
  let release; const calls = [], updates = [], held = new Promise(resolve => { release = resolve; });
  const intention = 'Je m’intéresse aux Conversos, tous ces Juifs qui se sont convertis apparemment en Espagne. ' + 'Je veux comprendre leur histoire et leurs traditions. '.repeat(8);
  const pending = discoverLocalYouTube({ intention, plan: () => held, onProgress: b => updates.push(b),
    search: async query => { calls.push(query); return result('abcdefghijk'); } });
  await new Promise(setImmediate);
  try { assert.deepEqual(calls, ['Conversos']); assert.equal(updates[0].videos.length, 1); }
  finally { release(plan); await pending; }
});

test('unshown DIRECT candidates cannot consume matching RELATED or joker cards', async () => {
  let calls = 0;
  const pool = Array.from({ length: 14 }, (_, i) => ({ ...result(String(i).padStart(11, '0')).videos[0], title: `Maya archaeology ${i}` }));
  const final = await discoverLocalYouTube({ intention: 'Maya archaeology', plan: async () => plan,
    search: async () => ({ requests: 2, search_results: 14, videos: ++calls === 1 ? pool : pool.slice(8, 12) }),
    wildcards: async () => ({ videos: [{ ...pool[12], discovery_stream: 'wildcard' }] }) });
  const rows = selectSearchColumns(final.videos, true);
  assert.equal(rows.direct.length, 8); assert.equal(rows.related.length, 4); assert.equal(rows.wildcard.length, 1);
  assert.equal(new Set(Object.values(rows).flat().map(v => v.video_id)).size, 13);
  assert.equal(calls, 5);
});

test('related angles share one OR call while jokers are still pending', async () => {
  let release, calls = 0; const updates = [], held = new Promise(resolve => { release = resolve; });
  const pending = discoverLocalYouTube({ intention: 'Maya archaeology', plan: async () => plan,
    search: async query => { calls++; if (calls === 2) return { requests: 1, search_results: 0, videos: [] };
      if (calls === 4) assert.equal(query, 'adjacent archaeology 2'); return result(calls === 1 ? 'abcdefghijk' : 'lmnopqrstuv'); },
    wildcards: async () => { await held; return { videos: [] }; }, onProgress: value => updates.push(structuredClone(value)) });
  await new Promise(setImmediate);
  assert.equal(calls, 3); assert.equal(updates.at(-1).streams.adjacent.status, 'complete');
  assert.equal(updates.at(-1).streams.adjacent.videos.length, 0); assert.equal(updates.at(-1).complete, false);
  release(); const final = await pending; assert.equal(final.youtube_searches, 5);
});

test('a single explicit subject focuses the first page before planning', async () => {
  assert.equal(conciseQuickQuery('Je suis intéressé par les martingales.'), 'martingales');
  assert.equal(conciseQuickQuery("Je m’intéresse à la civilisation chinoise."), 'civilisation chinoise');
  assert.equal(conciseQuickQuery('Learning mathematics'), 'Learning mathematics');
  let calls = 0;
  const final = await discoverLocalYouTube({ intention: 'Je suis intéressé par les martingales.', plan: async () => ({ ...plan, direct_subjects: ['martingale', 'martingales'] }),
    search: async query => { calls++; if (calls > 1) return { requests: 1, search_results: 0, videos: [] };
      assert.equal(query, 'martingales'); return { requests: 2, search_results: 2, videos: [
        { ...result('abcdefghijk').videos[0], title: 'Martingale theory and stopping times' },
        { ...result('lmnopqrstuv').videos[0], title: 'Pineapple quilt block using creative grids' },
      ] }; } });
  assert.deepEqual(final.streams.direct.videos.map(v => v.video_id), ['abcdefghijk']);
});

test('planner aliases never wipe the first column and related angles do not replace it', async () => {
  let release; const calls = [], updates = [], held = new Promise(resolve => { release = resolve; });
  const pending = discoverLocalYouTube({ intention: 'Maya archaeology', plan: () => held,
    wildcards: async () => ({ videos: [] }), onProgress: batch => updates.push(structuredClone(batch)),
    search: async query => { calls.push(query); return result(calls.length < 3 ? 'abcdefghijk' : 'lmnopqrstuv'); } });
  await new Promise(setImmediate); assert.equal(updates[0].streams.direct.videos.length, 1);
  release({ ...plan, direct_subjects: ['different spelling from planner'] });
  const final = await pending;
  assert.deepEqual(final.streams.direct.videos.map(v => v.video_id), ['abcdefghijk']);
  assert.deepEqual(calls.slice(0, 3), ['Maya archaeology', 'adjacent archaeology 0 | adjacent archaeology 1', 'wildcard archaeology 0 | wildcard archaeology 1']);
  assert.equal(final.streams.wildcard.videos[0].video_id, 'lmnopqrstuv');
  assert.ok(updates.every(batch => batch.streams.direct.videos[0]?.video_id === 'abcdefghijk'));
});

test('French conversational intent publishes ranked English API hits without waiting for translation', async () => {
  let release; const updates = [], calls = [], held = new Promise(resolve => { release = resolve; });
  const pending = discoverLocalYouTube({ intention: "Ça me tente d'en savoir plus sur les aborigènes d'Australie.",
    plan: () => held, onProgress: batch => updates.push(structuredClone(batch)),
    search: async query => { calls.push(query); const id = calls.length === 1 ? 'abcdefghijk' : 'lmnopqrstuv'; return { ...result(id), videos: [{ ...result(id).videos[0], title: 'Aboriginal Australians: The oldest living culture' }] }; } });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["aborigènes d'Australie"]);
  assert.equal(updates[0].videos.length, 1); assert.equal(updates[0].complete, false);
  release({ ...plan, direct_subjects: ['Aboriginal Australians'] });
  const final = await pending; assert.equal(final.streams.direct.videos[0].video_id, 'abcdefghijk'); assert.equal(calls.length, 5);
});

test('hybrid publishes both API columns while slow web jokers run independently', async () => {
  let release, calls = 0; const batches = [];
  const held = new Promise(resolve => { release = resolve; });
  const pending = discoverLocalYouTube({ intention: 'Maya archaeology', preferences: defaultPreferences(), plan: async () => plan,
    search: async query => { calls++; if (calls === 2) { assert.equal(query, 'adjacent archaeology 0 | adjacent archaeology 1'); assert.doesNotMatch(query, /wildcard/); } return result(calls === 1 ? 'abcdefghijk' : 'lmnopqrstuv'); },
    wildcards: async (_signal, publish) => { await held; const batch = { videos: [{ video_id: 'web:https://vimeo.com/123456', discovery_stream: 'wildcard' }] }; publish(batch); return batch; },
    onProgress: value => batches.push(structuredClone(value)) });
  await new Promise(setImmediate);
  assert.equal(calls, 3); assert.equal(batches.at(-1).streams.direct.videos.length, 1); assert.equal(batches.at(-1).streams.wildcard.videos.length, 1); assert.equal(batches.at(-1).complete, false);
  assert.equal(batches.at(-1).streams.adjacent.searches.length, 1);
  release(); const final = await pending;
  assert.equal(final.streams.wildcard.videos.length, 2); assert.equal(final.complete, true);
});
test('local API publishes early results and tops up sparse OR pools', async () => {
  let release; const calls = [], partials = [];
  const held = new Promise(resolve => { release = resolve; });
  const pending = discoverLocalYouTube({ intention: 'Maya archaeology', preferences: defaultPreferences(), plan: () => held,
    search: async query => { calls.push(query); return calls.length === 1 ? result('abcdefghijk') : { requests: 2, search_results: 4,
      videos: Array.from({ length: 4 }, (_, i) => ({ ...result(String(i).padStart(11, '0')).videos[0], title: `Maya ${i}` })) }; }, onProgress: value => partials.push(structuredClone(value)) });
  await new Promise(setImmediate);
  assert.equal(calls.length, 1); assert.equal(partials.length, 1); assert.equal(partials[0].videos.length, 1);
  release(plan); const final = await pending;
  assert.equal(calls.length, 5); assert.equal(final.youtube_searches, 5); assert.equal(final.streams.adjacent.videos.length, 4); assert.equal(final.streams.wildcard.videos.length, 4);
  assert.equal(final.complete, true); assert.equal(final.provider, 'youtube_api');
});
test('local API preserves first results when ChatGPT fails; cancellation never launches another page', async () => {
  let calls = 0;
  const final = await discoverLocalYouTube({ intention: 'Maya archaeology', preferences: defaultPreferences(),
    plan: async () => { throw Error('offline'); }, search: async () => { calls++; return result('abcdefghijk'); } });
  assert.equal(final.videos.length, 1); assert.equal(calls, 1); assert.equal(final.warning, 'REQUEST_FAILED');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverLocalYouTube({ intention: 'Maya archaeology', signal: controller.signal, plan: async () => plan,
    search: async () => assert.fail('Cancelled') }), { code: 'CANCELLED' });
});
