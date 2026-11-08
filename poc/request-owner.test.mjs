import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestOwner } from './request-owner.mjs';

test('superseded requests cannot finish their successor and cancellation invalidates before abort listeners run', () => {
  const owner = createRequestOwner();
  const first = owner.start();
  first.signal.addEventListener('abort', () => assert.equal(first.isCurrent(), false));
  const second = owner.start();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.finish(), false);
  assert.equal(owner.active, true);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.finish(), true);
  assert.equal(second.finish(), false);
  assert.equal(owner.active, false);
  const third = owner.start();
  owner.cancel(); owner.cancel();
  assert.equal(third.signal.aborted, true);
  assert.equal(third.finish(), false);
  assert.equal(owner.active, false);
});
