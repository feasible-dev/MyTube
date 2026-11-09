import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { mountWelcome } from './welcome.mjs';

async function fixture({ request = async () => ({ configured: false }), connect = async () => {}, supported = true, setup = async () => {} } = {}) {
  const { document } = parseHTML(await readFile(new URL('welcome.html', import.meta.url), 'utf8'));
  const select = document.getElementById('browser-choice');
  Object.defineProperty(select, 'value', {
    get() { return [...this.options].find(option => option.selected)?.value ?? 'chrome'; },
    set(value) { for (const option of this.options) option.toggleAttribute('selected', option.value === value); },
  });
  const guide = mountWelcome({ document, request, api: { runtime: { id: 'a'.repeat(32) } },
    live: { status: () => ({ ready: supported }), connect, setupYouTubeKey: setup } });
  await guide.ready;
  return { document, guide, el: id => document.getElementById(id) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('welcome checks the companion without initiating login; saved key is not presented as validated', async () => {
  let logins = 0;
  const { el } = await fixture({ request: async () => ({ configured: true }), connect: async () => { logins++; } });
  assert.equal(logins, 0);
  assert.match(el('companion-status').textContent, /connected/);
  assert.match(el('youtube-status').textContent, /validation happens on your first search/);
  assert.equal(el('chatgpt').disabled, false);
  el('chatgpt').click(); await settle();
  assert.equal(logins, 1);
  assert.match(el('chatgpt-status').textContent, /ChatGPT connected/);
});
test('unavailable or invalid status blocks actions without displaying raw errors', async () => {
  for (const request of [async () => { throw new Error('sensitive diagnostic'); }, async () => ({ configured: 'yes' })]) {
    const { document, el } = await fixture({ request });
    assert.equal(el('youtube').disabled, true);
    assert.equal(el('chatgpt').disabled, true);
    assert.equal(el('check').disabled, false);
    assert.ok(!document.body.textContent.includes('sensitive diagnostic'));
  }
});
test('key dialog launch does not claim the key was saved', async () => {
  const { el } = await fixture();
  el('youtube').click(); await settle();
  assert.match(el('youtube-status').textContent, /does not confirm a saved key/);
});
test('sign-in can be cancelled and retried', async () => {
  const { el } = await fixture({ connect: signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))) });
  el('chatgpt').click();
  assert.equal(el('cancel').hidden, false);
  assert.equal(el('check').disabled, true);
  el('cancel').click(); await settle();
  assert.match(el('chatgpt-status').textContent, /cancelled/);
  assert.equal(el('chatgpt').disabled, false);
});
test('unsupported browser never probes the companion', async () => {
  const { el } = await fixture({ supported: false, request: () => { throw new Error('must not probe'); } });
  assert.equal(el('unsupported').hidden, false);
  assert.equal(el('check').disabled, true);
});
