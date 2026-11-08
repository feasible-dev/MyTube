import test from 'node:test';
import assert from 'node:assert/strict';
import { readRequestBytes } from './request-body.mjs';

test('body limits count bytes across chunks, including split UTF-8 characters', async () => {
  const body = Buffer.from('{"topic":"\u00e9"}');
  async function* chunks() {
    for (const byte of body) yield Buffer.from([byte]);
  }
  assert.deepEqual(await readRequestBytes(chunks(), body.length), body);
  assert.equal(await readRequestBytes(chunks(), body.length - 1), null);
  assert.deepEqual(await readRequestBytes([], 16), Buffer.alloc(0));
});

test('oversized input stops consumption and closes the iterator without reading its tail', async () => {
  let closed = false;
  async function* chunks() {
    try {
      yield Buffer.alloc(8);
      yield Buffer.alloc(9);
      assert.fail('must not consume the rest of an oversized request');
    } finally { closed = true; }
  }
  assert.equal(await readRequestBytes(chunks(), 16), null);
  assert.equal(closed, true);
});

test('transport errors propagate to route-specific error handling', async () => {
  const error = new Error('synthetic stream failure');
  async function* chunks() { yield Buffer.from('{'); throw error; }
  await assert.rejects(readRequestBytes(chunks(), 4096), value => value === error);
});
