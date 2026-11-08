import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderBlockedChannels } from './channel-controls.mjs';

test('unblocking targets the selected record even when names match, and export follows the rendered list', () => {
  const { document } = parseHTML('<div id="blocked-channels-list"></div><a id="export-blocked-channels"></a>');
  const name = '<img src=x onerror=alert(1)>';
  const records = [
    { name, aliases: ['handle:first'], addedAt: 1 },
    { name, aliases: ['handle:second'], addedAt: 2 },
  ];
  const actions = [];
  renderBlockedChannels(document, records, record => actions.push(record));
  assert.equal(document.querySelector('img'), null);
  assert.equal(document.querySelector('.blocked-channel-row span').textContent, name);
  document.querySelectorAll('button')[1].click();
  assert.equal(actions[0], records[1]);
  assert.equal(records.length, 2, 'Rendering and requesting an unblock do not mutate records');
  const exported = () => JSON.parse(decodeURIComponent(document.getElementById('export-blocked-channels').getAttribute('href').split(',')[1]));
  assert.deepEqual(exported(), { version: 1, channels: records });
  renderBlockedChannels(document, [], record => actions.push(record));
  assert.equal(document.querySelectorAll('button').length, 0);
  assert.match(document.getElementById('blocked-channels-list').textContent, /Use Ban channel/);
  assert.deepEqual(exported(), { version: 1, channels: [] });
});
