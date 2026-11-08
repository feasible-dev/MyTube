import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCurrentPage } from './ui-harness.mjs';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const plan = { direct_subjects: ['THX Deep Note'], queries: ['direct', 'adjacent', 'wildcard'].map(stream => ({ stream,
  query: stream === 'direct' ? 'THX Deep Note creation' : `${stream} sound design`, why: 'A related sound-design angle' })) };
const ready = { decision: 'ready', search_intention: 'Learn about THX Deep Note creation', summary: 'You mean the THX Deep Note sound.', question: '', options: [], plan };
const wait = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate); assert.ok(predicate()); };

test('clarification blocks retrieval, preserves the request, then reuses the interpreted plan', async () => {
  const requests = []; let interpretations = 0;
  const { document, window, start } = await loadCurrentPage({ interpretation: true, localKey: true, preflight: true, windows: { create: async () => assert.fail('Already connected') },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/authorization')) return json({ authorization_url: null });
      if (url.endsWith('/connect')) return json({ connected: true });
      const body = JSON.parse(init.body); requests.push({ url, body });
      if (url.endsWith('/interpret')) return json(++interpretations === 1
        ? { decision: 'clarify', search_intention: '', summary: 'Two sounds may fit.', question: 'Do you mean THX Deep Note?', options: ['Yes, THX Deep Note', 'No, Dolby'], plan: null } : ready);
      if (url.endsWith('/youtube/search')) return json({ videos: [], requests: 1, search_results: 0 });
      if (url.endsWith('/wildcard-discover')) return json({ videos: [], searches: 1 });
      assert.fail(`Unexpected route ${url}`);
    } });
  start(); document.getElementById('new-search').click();
  await wait(() => document.getElementById('query-dialog').hasAttribute('open'));
  const original = 'That cinema sound, perhaps Dolby, descending then rising';
  document.getElementById('query-input').value = original;
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(() => !document.getElementById('query-clarification').hidden);
  assert.equal(requests.length, 1); assert.equal(document.getElementById('query-input').value, original);
  assert.match(document.getElementById('interpretation-status').textContent, /Waiting for your answer/);
  assert.equal(document.getElementById('submit-query').textContent, 'Continue');
  assert.equal(document.getElementById('interpretation-status').classList.contains('analysis-active'), false);
  document.querySelector('#clarification-options button').click();
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), false);
  assert.match(document.querySelector('.search-progress').textContent, /Analyzing your request/);
  assert.ok(document.querySelector('.search-progress').classList.contains('analysis-active'));
  // Native dialog.close dispatches this event asynchronously in Chrome.
  document.getElementById('query-dialog').dispatchEvent(new window.Event('close'));
  assert.equal(document.getElementById('clarification-answer').disabled, true);
  assert.equal(document.querySelector('#clarification-options button').disabled, true);
  assert.match(document.getElementById('interpretation-status').textContent, /Analyzing your request/);
  await wait(() => requests.some(r => r.url.endsWith('/youtube/search')));
  assert.match(requests[1].body.intention, /User answer: Yes, THX Deep Note/);
  assert.equal(requests.find(r => r.url.endsWith('/youtube/search')).body.query, '"THX Deep Note"');
  assert.ok(!requests.some(r => r.url.endsWith('/plan')));
  assert.equal(document.getElementById('current-topic').textContent, original);
  assert.equal(document.getElementById('interpreted-request').textContent, ready.summary);
  await wait(() => document.getElementById('streams').getAttribute('aria-busy') === 'false');
});

test('cancelling preparation on the main page prevents a late clarification answer from starting retrieval', async () => {
  let finish, calls = 0;
  const { document, window, start } = await loadCurrentPage({ interpretation: true, fetchImpl: async url => {
    assert.ok(url.endsWith('/interpret')); calls++;
    if (calls === 1) return json({ decision: 'clarify', search_intention: '', summary: 'Identify sound', question: 'Which sound?', options: ['THX', 'Dolby'], plan: null });
    return new Promise(resolve => { finish = () => resolve(json(ready)); });
  } });
  start(); document.getElementById('new-search').click();
  document.getElementById('query-input').value = 'Cinema sound';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(() => !document.getElementById('query-clarification').hidden);
  document.querySelector('#clarification-options button').click();
  await wait(() => Boolean(finish));
  document.getElementById('query-dialog').dispatchEvent(new window.Event('close'));
  document.querySelector('.search-progress button').click(); finish();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(calls, 2); assert.equal(document.getElementById('streams').getAttribute('aria-busy'), 'false');
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), false);
});

test('canceling interpretation keeps the draft and prevents a late answer from searching', async () => {
  let finish; const requests = [];
  const { document, window, start } = await loadCurrentPage({ interpretation: true,
    fetchImpl: (url, init) => { requests.push(url); assert.ok(url.endsWith('/interpret')); return new Promise(resolve => { finish = () => resolve(json(ready)); }); } });
  start(); document.getElementById('new-search').click();
  document.getElementById('query-input').value = 'Cinema sound';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(() => Boolean(finish)); document.getElementById('cancel-query').click(); finish();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(requests.length, 1); assert.equal(document.getElementById('query-input').value, 'Cinema sound');
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), false);
});

test('a clear request searches automatically with its enriched intention and no clarification', async () => {
  const requests = [];
  const { document, window, start } = await loadCurrentPage({ interpretation: true, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, body });
    if (url.endsWith('/interpret')) return json(ready);
    assert.ok(url.endsWith('/web-discover'));
    assert.equal(body.intention, ready.search_intention);
    return json({ videos: [], searches: 1 });
  } });
  start(); document.getElementById('new-search').click();
  document.getElementById('query-input').value = 'How was THX Deep Note made?';
  document.getElementById('query-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(() => requests.length === 2);
  assert.equal(document.getElementById('query-clarification').hidden, true);
  assert.equal(document.getElementById('query-dialog').hasAttribute('open'), false);
  await wait(() => document.getElementById('streams').getAttribute('aria-busy') === 'false');
});
