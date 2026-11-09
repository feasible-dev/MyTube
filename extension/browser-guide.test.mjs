import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { detectBrowser, bindBrowserGuide } from './browser-guide.mjs';

test('browser guidance detects Edge before Chromium, Brave despite Chrome UA, and Firefox manifest', async () => {
  assert.equal(await detectBrowser({}, { userAgent: 'Chrome/140 Edg/140' }), 'edge');
  assert.equal(await detectBrowser({}, { userAgent: 'Chrome/140', brave: { isBrave: async () => true } }), 'brave');
  assert.equal(await detectBrowser({ runtime: { getManifest: () => ({ browser_specific_settings: { gecko: {} } }) } }, {}), 'firefox');
  assert.equal(await detectBrowser({}, { userAgent: 'Chrome/140' }), 'chrome');
});

test('manual browser choice survives delayed detection and provides matching install and pin instructions', async () => {
  const { document, window } = parseHTML(await readFile(new URL('welcome.html', import.meta.url), 'utf8'));
  const select = document.getElementById('browser-choice');
  let selected = 'chrome', finish;
  Object.defineProperty(select, 'value', { get: () => selected, set: value => { selected = value; } });
  const guide = bindBrowserGuide({ document, api: {}, navigator: { brave: { isBrave: () => new Promise(resolve => { finish = resolve; }) } } });
  select.value = 'edge'; select.dispatchEvent(new window.Event('change'));
  finish(true); await guide.ready;
  assert.equal(select.value, 'edge');
  assert.equal(document.getElementById('browser-manager').textContent, 'edge://extensions');
  assert.match(document.getElementById('pin-instructions').textContent, /Show in toolbar/);
  select.value = 'firefox'; select.dispatchEvent(new window.Event('change'));
  assert.match(document.getElementById('install-instructions').textContent, /dist\/firefox\/manifest.json/);
  assert.match(document.getElementById('pin-instructions').textContent, /Pin to Toolbar/);
  assert.equal(document.getElementById('firefox-reminder').hidden, false);
});
