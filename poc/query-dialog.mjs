import { createRequestOwner } from './request-owner.mjs';

// Owns the connection gate and query dialog, not search execution or credentials.
export function createQueryDialog({ document, getStatus, getProvider, updateHelp, cancelSearch, messages }) {
  const $ = id => document.getElementById(id);
  const requests = createRequestOwner();
  async function openQuery(text, editing = false) {
    if (requests.active) return;
    $('query-title').textContent = editing ? 'Edit your request' : 'New search';
    $('submit-query').textContent = editing ? 'Search again' : 'Find videos';
    $('query-input').value = text;
    $('query-error').textContent = '';
    updateHelp();
    if (getStatus().provider !== 'chatgpt_web' || !getProvider()?.connect) { $('query-dialog').showModal(); $('query-input').focus(); return; }
    cancelSearch();
    const request = requests.start();
    $('query-input').disabled = true; $('submit-query').disabled = true;
    $('new-search').disabled = true;
    $('connection-status').hidden = false; $('cancel-connection').hidden = false;
    $('connection-message').textContent = 'Connecting to ChatGPT…';
    try {
      await getProvider().connect(request.signal, stage => {
        if (!request.isCurrent()) return;
        $('connection-message').textContent = stage === 'authorizing' ? 'Complete sign-in in the ChatGPT window…'
          : stage === 'waiting-connector' ? 'Finishing the previous request…' : 'Connecting to ChatGPT…';
      });
      if (!request.isCurrent()) return;
      $('connection-status').hidden = true;
      $('query-input').disabled = false; updateHelp();
      $('query-dialog').showModal(); $('query-input').focus();
    } catch (error) {
      if (!request.isCurrent()) return;
      $('cancel-connection').hidden = true;
      $('connection-message').textContent = messages[error?.code] ?? messages.CONNECTOR_UNAVAILABLE;
    } finally {
      if (request.finish()) $('new-search').disabled = false;
    }
  }
  function cancelQueryConnection() {
    requests.cancel();
    $('query-input').disabled = false;
    $('new-search').disabled = false; $('connection-status').hidden = true;
  }
  $('cancel-connection').addEventListener('click', cancelQueryConnection);
  for (const id of ['settings-button', 'languages-button', 'history-button', 'saved-tab']) $(id).addEventListener('click', cancelQueryConnection);
  document.querySelector('.brand').addEventListener('click', cancelQueryConnection);
  for (const id of ['close-query', 'cancel-query']) $(id).addEventListener('click', cancelQueryConnection);
  $('query-dialog').addEventListener('cancel', cancelQueryConnection);
  $('query-dialog').addEventListener('close', cancelQueryConnection);
  return { open: openQuery, cancel: cancelQueryConnection, get connecting() { return requests.active; } };
}
