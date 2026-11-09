import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { bindTheme, THEME_KEY } from './theme.mjs';

function page(storage) {
  const { document, window } = parseHTML('<html><body><button id="theme-toggle" type="button"></button></body></html>');
  bindTheme({ document, events: window, storage });
  return { document, window, button: document.getElementById('theme-toggle') };
}
test('theme toggles, persists on reopen and leaves viewing preferences and history untouched', () => {
  const values = new Map([['mytube.viewing-preferences', 'unchanged'], ['mytube.home', 'unchanged']]);
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const first = page(storage);
  assert.equal(first.document.documentElement.dataset.theme, 'light');
  first.button.click();
  assert.equal(first.document.documentElement.dataset.theme, 'dark');
  assert.equal(first.button.getAttribute('aria-label'), 'Dark theme');
  assert.equal(first.button.getAttribute('aria-checked'), 'true');
  const reopened = page(storage);
  assert.equal(reopened.document.documentElement.dataset.theme, 'dark');
  reopened.button.click();
  assert.equal(reopened.button.getAttribute('aria-checked'), 'false');
  assert.equal(values.get(THEME_KEY), 'light');
  assert.equal(values.get('mytube.viewing-preferences'), 'unchanged');
  assert.equal(values.get('mytube.home'), 'unchanged');
});
test('invalid or unavailable storage still permits theme switching', () => {
  for (const storage of [{ getItem: () => 'unexpected', setItem() {} }, { getItem() { throw Error(); }, setItem() { throw Error(); } }]) {
    const { document, button } = page(storage);
    assert.equal(document.documentElement.dataset.theme, 'light');
    button.click();
    assert.equal(document.documentElement.dataset.theme, 'dark');
  }
});
test('theme synchronizes between open extension pages without reacting to unrelated settings', () => {
  const storage = { getItem: () => 'dark' };
  const { document, window } = page(storage);
  function change(key, newValue) {
    const event = new window.Event('storage');
    Object.assign(event, { key, newValue, storageArea: storage });
    window.dispatchEvent(event);
  }
  change('mytube.home', null);
  assert.equal(document.documentElement.dataset.theme, 'dark');
  change(THEME_KEY, 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  change(THEME_KEY, 'dark');
  change(THEME_KEY, null);
  assert.equal(document.documentElement.dataset.theme, 'light');
});
