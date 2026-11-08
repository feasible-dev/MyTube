import { createElementFactory } from './dom.mjs';
import { channelBlocksJSON } from './channel-blocks.mjs';

// Render a snapshot; the application decides how to persist an unblock action.
export function renderBlockedChannels(document, records, onUnblock) {
  const element = createElementFactory(document);
  const list = document.getElementById('blocked-channels-list');
  list.replaceChildren();
  for (const record of records) {
    const item = element('div', 'blocked-channel-row');
    const name = element('span', '', record.name);
    const undo = element('button', 'outline-button', 'Unblock'); undo.setAttribute('aria-label', `Unblock ${record.name}`);
    undo.addEventListener('click', () => onUnblock(record));
    item.append(name, undo); list.append(item);
  }
  if (!records.length) {
    list.append(element('p', 'settings-note', 'No blocked channels. Use Ban channel on a video card.'));
  }
  document.getElementById('export-blocked-channels').href =
    `data:application/json;charset=utf-8,${encodeURIComponent(channelBlocksJSON(records))}`;
}
