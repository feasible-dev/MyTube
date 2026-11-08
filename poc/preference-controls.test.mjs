import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { defaultPreferences } from '../extension/preferences.mjs';
import { bindPreferenceControls } from './preference-controls.mjs';

test('controls use the latest preferences after an external replacement without mutating the old snapshot', async () => {
  const { document, window } = parseHTML(await readFile(new URL('./template.html', import.meta.url), 'utf8'));
  const initial = Object.freeze({ ...defaultPreferences(), languages: Object.freeze(['en']) });
  let preferences = initial;
  const changes = [];
  const controls = bindPreferenceControls({ document, getPreferences: () => preferences,
    onChange(next, renderResults) { preferences = next; changes.push(renderResults); } });
  controls.sync();
  // Storage events can replace the whole preference object while the panel exists.
  preferences = Object.freeze({ ...initial, depth: 100, minMinutes: 60, maxMinutes: 90, languages: Object.freeze(['fr']) });
  controls.sync();
  assert.equal(document.getElementById('pref-depth').value, '100');
  assert.equal(document.getElementById('video-language-value').textContent, 'French');
  const french = document.querySelector('[data-language="fr"]');
  french.checked = false; french.dispatchEvent(new window.Event('change'));
  assert.equal(french.checked, true);
  assert.deepEqual(changes, []);
  const english = document.querySelector('[data-language="en"]');
  english.checked = true; english.dispatchEvent(new window.Event('change'));
  assert.deepEqual(preferences.languages, ['fr', 'en']);
  const min = document.getElementById('min-duration');
  min.value = '100'; min.dispatchEvent(new window.Event('input'));
  assert.equal(preferences.minMinutes, 100);
  assert.equal(preferences.maxMinutes, 100);
  assert.equal(preferences.depth, 100);
  assert.deepEqual(initial.languages, ['en']);
  assert.deepEqual(changes, [false, true]);
  document.getElementById('reset-preferences').click();
  assert.deepEqual(preferences, defaultPreferences());
  assert.equal(document.getElementById('video-language-value').textContent, 'English');
});
