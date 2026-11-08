import { LiveSearchError } from './youtube-live.mjs';

export function validateAuthorizationUrl(value) {
  try {
    const url = new URL(value), callback = new URL(url.searchParams.get('redirect_uri'));
    if (typeof value !== 'string' || value.length > 8192 || url.origin !== 'https://auth.openai.com'
      || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash
      || url.searchParams.has('id_token_hint') || url.searchParams.get('response_type') !== 'code'
      || url.searchParams.get('code_challenge_method') !== 'S256'
      || callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port
      || callback.pathname !== '/auth/callback' || callback.search || callback.hash || callback.username || callback.password) throw Error();
    return url.href;
  } catch { throw new LiveSearchError('INVALID_SEARCH_PLAN'); }
}

// Only the window created for this request is closed. No tabs permission,
// browsing-history inspection, token access or callback-URL inspection needed.
export function authorizationWindowBounds(display = globalThis.screen) {
  const availableWidth = Math.floor(display?.availWidth), availableHeight = Math.floor(display?.availHeight);
  // Cap both dimensions on large displays; never maximize automatically.
  // Provider pages remain scrollable and the native window stays resizable.
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight)
    || availableWidth <= 0 || availableHeight <= 0) return { width: 600, height: 960 };
  const width = Math.min(600, Math.max(1, availableWidth - 32));
  const height = Math.min(960, Math.max(1, Math.floor(availableHeight * 0.9)));
  const left = Number.isFinite(display.availLeft) ? display.availLeft : 0;
  const top = Number.isFinite(display.availTop) ? display.availTop : 0;
  return { width, height, left: Math.round(left + (availableWidth - width) / 2), top: Math.round(top + (availableHeight - height) / 2) };
}
function pausePolling(ms, signal) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
export async function watchAuthorization({ api, requestId, signal, fetchImpl = fetch, pause = pausePolling, display = globalThis.screen, keepWatching = false, onStatus = () => {} }) {
  let windowId, shown = false, shownUrl;
  const closeWindow = async () => {
    if (windowId === undefined) return;
    const id = windowId; windowId = undefined;
    try { await api.windows.remove(id); } catch { /* User may already have closed it. */ }
  };
  try {
    while (!signal.aborted) {
      // Privileged extension GETs can omit Origin. Use the same JSON POST
      // boundary as /plan; never weaken the connector's exact-Origin check.
      const response = await fetchImpl('http://127.0.0.1:43817/authorization', { method: 'POST', body: '{}', cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', 'X-MyTube-Request': requestId },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new LiveSearchError(response.status === 403 ? 'CONNECTOR_ACCESS_DENIED'
          : [400, 404, 405].includes(response.status) ? 'CONNECTOR_UPDATE_REQUIRED' : 'CONNECTOR_PROTOCOL_ERROR');
      }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new LiveSearchError('CONNECTOR_PROTOCOL_ERROR');
      const reader = response.body.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > 16384) throw new LiveSearchError('INVALID_SEARCH_PLAN'); text += decoder.decode(chunk.value, { stream: true });
      } text += decoder.decode(); } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(text);
      if (!value || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'authorization_url')) throw new LiveSearchError('INVALID_SEARCH_PLAN');
      if (signal.aborted) break;
      if (value.authorization_url !== null) {
        const url = validateAuthorizationUrl(value.authorization_url);
        if (shown && shownUrl !== url) { await closeWindow(); shown = false; }
        if (!shown) {
          shown = true; shownUrl = url; onStatus('authorizing');
          const popup = await api.windows.create({ url, type: 'popup', ...authorizationWindowBounds(display), focused: true });
          if (!Number.isInteger(popup?.id)) throw new LiveSearchError('SIGN_IN_WINDOW_FAILED');
          windowId = popup.id;
        } else if (windowId !== undefined) {
          try { await api.windows.get(windowId); } catch { throw new LiveSearchError('CANCELLED'); }
        }
      } else if (shown) {
        await closeWindow(); shown = false; shownUrl = undefined; onStatus('planning');
        if (!keepWatching) return;
      }
      if (!signal.aborted) await pause(500, signal);
    }
  } finally { await closeWindow(); }
}
