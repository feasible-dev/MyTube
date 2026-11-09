import { localYouTubeRequest } from './local-youtube.mjs';
import { setupIdentity } from './connector-origin.mjs';
import { bindBrowserGuide } from './browser-guide.mjs';

// The guide stores no credentials or persistent "connected" flag. A new visit
// probes the companion again; opening settings never initiates provider login.
export function mountWelcome({ document, live, request = localYouTubeRequest, api = globalThis.browser ?? globalThis.chrome, navigator = globalThis.navigator }) {
  const el = id => document.getElementById(id);
  let busy = false, controller;
  const supported = live.status().ready;
  const browserGuide = bindBrowserGuide({ document, api, navigator });
  el('extension-id').textContent = setupIdentity(api) ?? 'Unavailable outside the extension';
  if (api?.runtime?.getURL) el('mytube-address').value = api.runtime.getURL('index.html');
  else el('direct-access').hidden = true;
  el('copy-identity').addEventListener('click', async () => {
    try {
      const identity = setupIdentity(api);
      if (!identity || !navigator?.clipboard?.writeText) throw Error();
      await navigator.clipboard.writeText(identity);
      el('copy-status').textContent = 'Copied. Paste this into the launcher.';
    } catch { el('copy-status').textContent = 'Select the connection ID above and copy it with Ctrl+C.'; }
  });
  el('unsupported').hidden = supported;
  function lock(value) {
    busy = value;
    for (const id of ['check', 'youtube', 'chatgpt']) el(id).disabled = value || !supported;
  }
  async function check() {
    if (busy || !supported) return;
    lock(true);
    el('companion-status').textContent = 'Checking the companion…';
    let connected = false;
    try {
      const result = await request('status', {});
      if (typeof result?.configured !== 'boolean') throw new Error('Invalid status');
      connected = true;
      el('companion-status').textContent = 'Companion connected.';
      el('youtube-status').textContent = result.configured ? 'Key saved on this computer. Google validation happens on your first search.' : 'No key saved yet. Open the Windows window to add yours.';
      el('youtube').textContent = result.configured ? 'Change YouTube key' : 'Connect YouTube';
    } catch {
      el('companion-help').open = true;
      el('companion-status').textContent = 'Cannot connect. Start MyTube.cmd and make sure the launcher uses the extension ID shown below.';
      el('youtube-status').textContent = 'Waiting for the companion.';
      el('chatgpt-status').textContent = 'Reconnect the companion before signing in.';
    } finally {
      lock(false);
      el('youtube').disabled = el('chatgpt').disabled = !connected;
    }
  }
  el('check').addEventListener('click', check);
  el('youtube').addEventListener('click', async () => {
    if (busy) return;
    lock(true);
    try {
      await live.setupYouTubeKey();
      el('youtube-status').textContent = 'Save your key in the Windows window, then choose Check connection. Opening the window does not confirm a saved key.';
    } catch {
      el('youtube-status').textContent = 'Could not open key setup. Check that the Windows companion is running, then retry.';
    } finally { lock(false); }
  });
  el('chatgpt').addEventListener('click', async () => {
    if (busy) return;
    lock(true); controller = new AbortController();
    el('cancel').hidden = false;
    el('chatgpt-status').textContent = 'Complete sign-in in the ChatGPT window…';
    try {
      await live.connect(controller.signal);
      el('chatgpt-status').textContent = 'ChatGPT connected. Open MyTube to start searching.';
    } catch {
      el('chatgpt-status').textContent = controller.signal.aborted ? 'Sign-in cancelled. You can try again.' : 'Sign-in did not finish. Check the companion and retry.';
    } finally { controller = undefined; el('cancel').hidden = true; lock(false); }
  });
  el('cancel').addEventListener('click', () => controller?.abort());
  if (!supported) {
    lock(false);
    el('companion-status').textContent = 'Connection unavailable in this browser.';
  }
  return { ready: Promise.all([check(), browserGuide.ready]), dispose: () => controller?.abort() };
}
