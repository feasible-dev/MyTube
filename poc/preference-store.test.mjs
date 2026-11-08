import test from 'node:test';
import assert from 'node:assert/strict';
import { loadViewingPreferences, saveViewingPreferences, VIEWING_PREFERENCES_KEY } from './preference-store.mjs';
import { defaultPreferences, validatePreferences } from '../extension/preferences.mjs';

function memory() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
test('viewing choices survive reopening independently of history and release numbers', () => {
  const storage = memory(), chosen = { ...defaultPreferences(), originality: 85, depth: 75, minMinutes: 12, maxMinutes: 90, languages: ['fr', 'en'] };
  saveViewingPreferences(storage, chosen);
  storage.setItem('mytube.home.v1', JSON.stringify({ version: 1, enabled: false }));
  assert.deepEqual(loadViewingPreferences(storage), validatePreferences(chosen));
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(VIEWING_PREFERENCES_KEY))), ['version', 'values']);
});
test('compatible older records retain valid choices and receive defaults only where needed', () => {
  const storage = memory();
  storage.setItem(VIEWING_PREFERENCES_KEY, JSON.stringify({ version: 1, values: {
    depth: 80, politics: 20, origin: 'bad', languages: ['fr', 'unknown', 'fr'], minMinutes: 10, maxMinutes: 60, removedAxis: 99,
  } }));
  assert.deepEqual(loadViewingPreferences(storage), { ...defaultPreferences(), depth: 75, politics: 25, languages: ['fr'], minMinutes: 10, maxMinutes: 60 });
});
test('first upgrade recovers the last search settings without overwriting subsequently saved choices', () => {
  const storage = memory(), previous = { ...defaultPreferences(), depth: 90 };
  assert.deepEqual(loadViewingPreferences(storage, previous), validatePreferences(previous));
  assert.ok(storage.getItem(VIEWING_PREFERENCES_KEY));
  const chosen = { ...previous, depth: 35 }; saveViewingPreferences(storage, chosen);
  assert.deepEqual(loadViewingPreferences(storage, previous), validatePreferences(chosen));
});
test('corrupt, oversized and unsupported records do not break loading or get silently overwritten', () => {
  const storage = memory();
  for (const raw of ['{', 'x'.repeat(16385), JSON.stringify({ version: 99, values: { depth: 90 } })]) {
    storage.setItem(VIEWING_PREFERENCES_KEY, raw);
    assert.deepEqual(loadViewingPreferences(storage), defaultPreferences());
    assert.equal(storage.getItem(VIEWING_PREFERENCES_KEY), raw);
  }
  assert.deepEqual(loadViewingPreferences({ getItem() { throw Error(); } }), defaultPreferences());
  assert.doesNotThrow(() => saveViewingPreferences({ setItem() { throw Error(); } }, defaultPreferences()));
});
