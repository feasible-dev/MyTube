import { fetchSubscriptionPage } from './subscriptions.mjs';
import { externalPreview } from './external-preview.mjs';
import { validateInterpretation } from './interpretation.mjs';
import { LiveSearchError, createVideoDurationLoader, fetchYouTubeResults, getGoogleToken } from './youtube-live.mjs';
import { requestDiscoveryPlan, prepareChatGPT } from './discovery.mjs';
import { createGoogleGate, createGoogleFallbackFetch } from './google-fallback.mjs';
import { discoverQuickly } from './quick-discovery.mjs';
import { discoverWebVideos } from './web-discovery.mjs';
import { requestWildcards } from './wildcard-discovery.mjs';
import { localYouTubeRequest, discoverLocalYouTube } from './local-youtube.mjs';
import { refreshHomeTopics } from './home-refresh.mjs';
import { watchAuthorization } from './auth-window.mjs';

// Browser entry point. The bundle keeps provider state inside a private scope.
const api = globalThis.chrome;
const googleGate = createGoogleGate();
const legacyVideoDurations = createVideoDurationLoader({ getToken: () => getGoogleToken(api, false) });
let localKeyConfigured = false;
async function loadVideoDurations(ids) {
  if (!localKeyConfigured) return legacyVideoDurations(ids);
  return (await localYouTubeRequest('durations', { ids })).videos;
}
function legacyStatus() {
  const manifest = api?.runtime?.getManifest?.();
  const extensionId = api?.runtime?.id ?? null;
  if (manifest?.browser_specific_settings?.gecko) return { ready: false, reason: 'BROWSER_AUTH_UNSUPPORTED', extensionId };
  if (!manifest?.oauth2?.client_id) return { ready: false, reason: 'GOOGLE_SETUP_REQUIRED', extensionId };
  if (typeof api?.identity?.getAuthToken !== 'function') return { ready: false, reason: 'BROWSER_AUTH_UNSUPPORTED', extensionId };
  return { ready: true, reason: null, extensionId };
}
function status() {
  const extensionId = api?.runtime?.id ?? null;
  if (api?.runtime?.getManifest?.()?.browser_specific_settings?.gecko) return { ready: false, reason: 'BROWSER_AUTH_UNSUPPORTED', extensionId };
  return { ready: Boolean(extensionId), reason: extensionId ? null : 'EXTENSION_REQUIRED', extensionId, provider: 'chatgpt_web' };
}
async function search(query, signal) {
  const current = legacyStatus();
  if (!current.ready) throw new LiveSearchError(current.reason);
  if (signal?.aborted) throw new LiveSearchError('CANCELLED');
  let token;
  try {
    token = await getGoogleToken(api, true);
    if (signal?.aborted) throw new LiveSearchError('CANCELLED');
    return await fetchYouTubeResults({ query, token, signal });
  } catch (error) {
    if (error?.code === 'SIGN_IN_REQUIRED' && token) {
      try { await api.identity.removeCachedAuthToken({ token }); } catch { /* No retry. */ }
    }
    throw error instanceof LiveSearchError ? error : new LiveSearchError('REQUEST_FAILED');
  } finally { token = undefined; }
}
async function discoverLegacy(intention, signal, onStage, onProgress, preferences, fallback = {}) {
  const current = legacyStatus();
  if (!current.ready) throw new LiveSearchError(current.reason);
  let token;
  try {
    const fetchImpl = createGoogleFallbackFetch(globalThis.fetch, { gate: googleGate, onRetry: () => onStage('retrying') });
    const report = result => ({ ...result, requests: fetchImpl.stats.requests, retry_requests: fetchImpl.stats.retries });
    return report(await discoverQuickly({ intention, signal, onStage, onProgress: result => onProgress(report(result)), preferences, fetchImpl,
      cached: fallback.cached ?? [],
      watch: api.windows?.create ? options => watchAuthorization({ ...options, api, keepWatching: true, onStatus: onStage }) : undefined,
      getQuickToken: () => getGoogleToken(api, false),
      getToken: async () => { token = await getGoogleToken(api, true); return token; } }));
  } catch (error) {
    if (error?.code === 'SIGN_IN_REQUIRED' && token) {
      try { await api.identity.removeCachedAuthToken({ token }); } catch { /* No retry. */ }
    }
    throw error instanceof LiveSearchError ? error : new LiveSearchError('REQUEST_FAILED');
  } finally { token = undefined; }
}
async function discoverWeb(intention, signal, onStage, onProgress, preferences, fallback = {}) {
  if (!api?.runtime?.id) throw new LiveSearchError('EXTENSION_REQUIRED');
  return discoverWebVideos({ intention, signal, onStage, onProgress, preferences, cached: fallback.cached ?? [],
    watch: api.windows?.create ? options => watchAuthorization({ ...options, api, keepWatching: true, onStatus: stage => onStage(stage === 'planning' ? 'web-search' : stage) }) : undefined });
}
async function interpret(intention, signal, preferences) {
  return requestDiscoveryPlan(intention, signal, globalThis.fetch,
    api.windows?.create ? options => watchAuthorization({ ...options, api, keepWatching: true }) : undefined, preferences,
    undefined, validateInterpretation, undefined, undefined, false, false, true);
}
async function discover(intention, signal, onStage, onProgress, preferences, fallback = {}) {
  if (!localKeyConfigured) return discoverWeb(intention, signal, onStage, onProgress, preferences, fallback);
  try {
    return await discoverLocalYouTube({ intention, signal, preferences, onStage, onProgress, preparedPlan: fallback.preparedPlan,
      wildcards: (requestSignal, publish) => requestWildcards(intention, requestSignal, preferences, publish,
        options => watchAuthorization({ ...options, api, keepWatching: true, onStatus: onStage }),
        waiting => { if (waiting) onStage('waiting-connector'); }),
      plan: requestSignal => requestDiscoveryPlan(intention, requestSignal, globalThis.fetch,
        options => watchAuthorization({ ...options, api, keepWatching: true, onStatus: onStage }), preferences) });
  } catch (error) {
    if (signal?.aborted || !['QUOTA_EXCEEDED', 'RATE_LIMITED', 'ACCESS_OR_QUOTA_DENIED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT'].includes(error?.code)) throw error;
    return discoverWeb(intention, signal, onStage, onProgress, preferences, fallback);
  }
}
async function connect(signal, onStage = () => {}) {
  if (!api?.runtime?.id) throw new LiveSearchError('EXTENSION_REQUIRED');
  if (!api.windows?.create) throw new LiveSearchError('SIGN_IN_WINDOW_FAILED');
  try {
    const capability = await localYouTubeRequest('status', {}, signal);
    if (typeof capability?.configured !== 'boolean') throw new LiveSearchError('INVALID_RESPONSE');
    localKeyConfigured = capability.configured;
  } catch (error) {
    localKeyConfigured = false;
    if (!['CONNECTOR_UPDATE_REQUIRED', 'CONNECTOR_UNAVAILABLE', 'TIMEOUT'].includes(error?.code)) throw error;
  }
  return prepareChatGPT(signal, globalThis.fetch,
    options => watchAuthorization({ ...options, api, keepWatching: true, onStatus: onStage }),
    waiting => onStage(waiting ? 'waiting-connector' : 'connecting'));
}
async function signOut() {
  try {
    const response = await fetch('http://127.0.0.1:43817/signout', { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1' }, body: '{}', signal: AbortSignal.timeout(35000) });
    // The connector returns only fixed status codes; don't reflect its body.
    await response.body?.cancel().catch(() => {});
    if (response.status === 409) throw new LiveSearchError('CONNECTOR_BUSY');
    if (!response.ok) throw new LiveSearchError('CLEANUP_REQUIRED');
  } catch (error) { throw error instanceof LiveSearchError ? error : new LiveSearchError('CONNECTOR_UNAVAILABLE'); }
}
async function refreshHome(topics, signal, onBatch) {
  if (!status().ready) throw new LiveSearchError('BROWSER_AUTH_UNSUPPORTED');
  return refreshHomeTopics({ topics, signal, onBatch, fetchImpl: createGoogleFallbackFetch(globalThis.fetch, { gate: googleGate, retries: 0 }), getToken: () => getGoogleToken(api, false) });
}
async function subscriptions(options = {}) {
  const current = legacyStatus();
  if (!current.ready) throw new LiveSearchError(current.reason);
  const token = await getGoogleToken(api, true);
  return fetchSubscriptionPage({ ...options, token });
}
globalThis.MyTubeLive = Object.freeze({ setupYouTubeKey: () => localYouTubeRequest('setup', {}), subscriptions, status, search, discover, discoverWeb, interpret, connect, loadExternalPreview: externalPreview, signOut, loadVideoDurations,
  legacyStatus, discoverLegacy, refreshHomeLegacy: refreshHome });
