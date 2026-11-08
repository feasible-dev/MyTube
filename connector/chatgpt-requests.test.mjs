import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatGPTRequest } from './chatgpt-requests.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';

test('ChatGPT request validation preserves modes, preferences and recovery without changing intention text', () => {
  const preferences = defaultPreferences(), intention = 'History of navigation';
  for (const [path, mode] of [['/interpret', 'interpret'], ['/plan', 'plan'], ['/web-discover', 'web'], ['/wildcard-discover', 'wildcard']]) {
    const body = { intention, preferences, recovery: 'NO_RESULTS' };
    assert.deepEqual(parseChatGPTRequest(path, body, false), { type: 'search', mode, intention, preferences, recovery: 'NO_RESULTS' });
    assert.equal(body.intention, intention);
  }
  assert.deepEqual(parseChatGPTRequest('/connect', {}, true), { type: 'connect' });
  assert.equal(parseChatGPTRequest('/connect', {}, false), null);
  assert.deepEqual(parseChatGPTRequest('/signout', {}, false), { type: 'signout' });
});

test('invalid envelopes remain distinct from invalid intention and preference errors', () => {
  for (const [path, body] of [
    ['/unknown', {}], ['/plan', {}], ['/connect', { intention: 'History' }],
    ['/plan', { intention: 'History', extra: true }], ['/plan', { intention: 'History', recovery: 'UNKNOWN' }],
  ]) assert.equal(parseChatGPTRequest(path, body, true), null);
  assert.throws(() => parseChatGPTRequest('/plan', { intention: '' }, true), { message: 'INVALID_INTENTION' });
  assert.throws(() => parseChatGPTRequest('/plan', { intention: 'History', preferences: { invalid: true } }, true), { message: 'INVALID_PREFERENCES' });
});
