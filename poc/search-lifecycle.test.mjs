import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchLifecycle } from './search-lifecycle.mjs';

function pendingProvider() {
  const request = {};
  request.execute = (signal, stage, progress) => {
    Object.assign(request, { signal, stage, progress });
    return new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
  };
  return request;
}

function fixture() {
  const state = {};
  const updates = [];
  const lifecycle = createSearchLifecycle({ state,
    changed: () => updates.push({ ...state }), errorCode: error => error.code ?? 'REQUEST_FAILED' });
  return { state, updates, lifecycle };
}

test('a superseded search cannot publish progress, completion or persistence effects', async () => {
  const { state, updates, lifecycle } = fixture();
  const first = pendingProvider(), second = pendingProvider();
  const completed = [], partials = [];
  const a = lifecycle.run(first.execute, { complete: value => completed.push(value), partial: value => partials.push(value) });
  first.progress({ videos: ['early'] });
  const b = lifecycle.run(second.execute, { complete: value => completed.push(value) });
  assert.equal(first.signal.aborted, true);
  second.stage('searching');
  second.progress({ videos: ['current'] });
  const before = { ...state }, count = updates.length;
  first.stage('obsolete');
  first.progress({ videos: ['obsolete'] });
  first.resolve({ videos: ['obsolete final'] });
  await a;
  assert.deepEqual(state, before);
  assert.equal(updates.length, count);
  assert.deepEqual(completed, []);
  assert.deepEqual(partials, [{ videos: ['early'] }]);
  assert.equal(lifecycle.active, true);
  const result = { videos: ['current final'], warning: 'PARTIAL_RESULTS' };
  second.resolve(result);
  await b;
  assert.deepEqual(completed, [result]);
  assert.equal(state.liveResult, result);
  assert.equal(state.liveError, 'PARTIAL_RESULTS');
  assert.equal(state.loading, false);
  assert.equal(lifecycle.active, false);
});

test('cancellation retains received results and ignores a late successful response', async () => {
  const { state, lifecycle } = fixture();
  const provider = pendingProvider();
  let persisted = false;
  const run = lifecycle.run(provider.execute, { complete: () => { persisted = true; } });
  const received = { videos: ['received'] };
  provider.progress(received);
  lifecycle.cancel('CANCELLED');
  assert.equal(provider.signal.aborted, true);
  assert.equal(lifecycle.active, false);
  provider.resolve({ videos: ['late'] });
  await run;
  assert.equal(persisted, false);
  assert.equal(state.liveResult, received);
  assert.equal(state.liveError, 'CANCELLED');
  assert.equal(state.loading, false);
});

test('provider failure retains partial results and ends the active search', async () => {
  const { state, lifecycle } = fixture();
  const provider = pendingProvider();
  const run = lifecycle.run(provider.execute);
  const received = { videos: ['received'] };
  provider.progress(received);
  provider.reject(new Error('provider unavailable'));
  await run;
  assert.equal(state.liveResult, received);
  assert.equal(state.liveError, 'REQUEST_FAILED');
  assert.equal(state.loading, false);
  assert.equal(lifecycle.active, false);
});
