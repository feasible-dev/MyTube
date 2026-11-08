import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

async function loadPage({ live = true, web = false, preflight = false, durations = false, interpretation = false, previews = false, localKey = false, fetchImpl, getAuthToken, windows, storage, observer, clock = () => Date.parse('2026-11-07T23:00:00Z'), interval = setInterval, clear = clearInterval } = {}) {
  const dir = new URL('../dist/brave/', import.meta.url);
  let html = await readFile(new URL('index.html', dir), 'utf8');
  const { document, window } = parseHTML(html);
  // LinkeDOM parses HTML and dispatches events but does not implement these
  // native browser UI APIs. Supply their narrow platform behavior, not app logic.
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', {
    get() { return [...this.options].find(o => o.selected)?.value ?? this.options[0]?.value ?? ''; },
    set(value) {
      const selected = [...this.options].find(option => option.value === value);
      for (const option of this.options) option.removeAttribute('selected');
      if (selected) selected.setAttribute('selected', '');
    },
  });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
  }
  for (const input of document.querySelectorAll('input,button,textarea')) input.focus = () => {};
  for (const form of document.querySelectorAll('form')) form.requestSubmit = () => form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
  const context = vm.createContext({ document, window, IntersectionObserver: observer, URL, URLSearchParams, AbortController, AbortSignal, crypto, console, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    setInterval: interval, clearInterval: clear, performance,
    fetch: (url, init) => url.endsWith('/youtube/status')
      ? Promise.resolve(new Response(JSON.stringify({ configured: localKey }), { headers: { 'content-type': 'application/json' } }))
      : (fetchImpl ?? (() => assert.fail('Unexpected network request')))(url, init),
    Date: class extends Date { static now() { return clock(); } },
    location: { protocol: live ? 'chrome-extension:' : 'file:' }, localStorage: storage,
    chrome: live ? { windows, runtime: { id: 'test-extension-id', getManifest: () => manifest }, identity: {
      getAuthToken: getAuthToken ?? (() => assert.fail('Loading the UI must not initiate sign-in')),
    } } : undefined,
  });
  if (live) vm.runInContext(await readFile(new URL('live.js', dir), 'utf8'), context, { timeout: 5000 });
  // Retain explicit coverage for the old API path while the web test uses the
  // actual default bridge, without substituting its discovery implementation.
  if (live && !web) vm.runInContext('globalThis.MyTubeLive = { ...MyTubeLive, status: MyTubeLive.legacyStatus, discover: MyTubeLive.discoverLegacy, refreshHome: MyTubeLive.refreshHomeLegacy };', context);
  // Most tests isolate result rendering; dedicated preflight tests exercise the real connection bridge.
  if (!preflight) vm.runInContext('if (globalThis.MyTubeLive) globalThis.MyTubeLive = { ...MyTubeLive, connect: undefined };', context);
  if (!durations) vm.runInContext('if (globalThis.MyTubeLive) globalThis.MyTubeLive = { ...MyTubeLive, loadVideoDurations: undefined };', context);
  if (!interpretation) vm.runInContext('if (globalThis.MyTubeLive) globalThis.MyTubeLive = { ...MyTubeLive, interpret: undefined };', context);
  if (!previews) vm.runInContext('if (globalThis.MyTubeLive) globalThis.MyTubeLive = { ...MyTubeLive, loadExternalPreview: undefined };', context);
  const start = () => vm.runInContext(context.appSource, context, { timeout: 5000 });
  context.appSource = web ? await readFile(new URL('app.js', dir), 'utf8')
    : (await readFile(new URL('../poc/index.html', import.meta.url), 'utf8')).match(/<script>([\s\S]*?)<\/script>/)[1];
  return { document, window, start, configured: Boolean(manifest.oauth2) };
}

export const loadCurrentPage = options => loadPage({ ...options, web: true });
export const loadLegacyPage = options => loadPage({ ...options, web: false });
