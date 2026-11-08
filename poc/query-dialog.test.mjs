import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createQueryDialog } from './query-dialog.mjs';

test('a provider that finishes after cancellation cannot reopen or unlock a newer connection', async () => {
  const { document } = parseHTML(await readFile(new URL('./template.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id);
  $('query-dialog').showModal = () => $('query-dialog').setAttribute('open', '');
  const requests = [];
  const provider = { connect(signal, progress) {
    return new Promise(resolve => requests.push({ signal, progress, resolve }));
  } };
  const dialog = createQueryDialog({ document,
    getStatus: () => ({ provider: 'chatgpt_web' }), getProvider: () => provider,
    updateHelp() { $('submit-query').disabled = false; }, cancelSearch() {}, messages: {} });
  const first = dialog.open('First topic');
  dialog.cancel();
  assert.equal(requests[0].signal.aborted, true);
  const second = dialog.open('Second topic', true);
  requests[1].progress('waiting-connector');
  const message = $('connection-message').textContent;
  requests[0].progress('authorizing');
  requests[0].resolve();
  await first;
  assert.equal(dialog.connecting, true);
  assert.equal($('connection-message').textContent, message);
  assert.equal($('query-dialog').hasAttribute('open'), false);
  assert.equal($('query-input').disabled, true);
  assert.equal($('new-search').disabled, true);
  assert.equal($('query-input').value, 'Second topic');
  assert.equal($('query-title').textContent, 'Edit your request');
  requests[1].resolve();
  await second;
  assert.equal(dialog.connecting, false);
  assert.equal($('query-dialog').hasAttribute('open'), true);
  assert.equal($('query-input').disabled, false);
  assert.equal($('new-search').disabled, false);
});
