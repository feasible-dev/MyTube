import { loadYouTubeKey } from './local-secrets.mjs';
import { openWindowsKeySetup } from './windows-key.mjs';
import { fetchYouTubeResults, createVideoDurationLoader, createChannelAvatarLoader } from '../extension/youtube-live.mjs';

export const YOUTUBE_PUBLIC_ERRORS = new Set(['WINDOWS_KEY_UNAVAILABLE', 'YOUTUBE_KEY_MISSING', 'YOUTUBE_KEY_INVALID', 'INVALID_QUERY', 'INVALID_PREFERENCES',
  'CANCELLED', 'TIMEOUT', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'ACCESS_OR_QUOTA_DENIED', 'PROVIDER_UNAVAILABLE', 'REQUEST_FAILED', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE']);

// Only this server-side transport receives the key. No generic proxy endpoint.
export function createKeyYouTube({ getKey = loadYouTubeKey, fetchImpl = globalThis.fetch } = {}) {
  const privateFetch = async (url, options) => {
    const target = new URL(url);
    if (target.origin !== 'https://www.googleapis.com' || !['/youtube/v3/search', '/youtube/v3/videos', '/youtube/v3/channels'].includes(target.pathname)
      || target.searchParams.has('key') || options.method !== 'GET') throw new Error('REQUEST_FAILED');
    const key = options.headers.Authorization?.slice(7);
    if (!key) throw new Error('YOUTUBE_KEY_MISSING');
    return fetchImpl(target.href, { ...options, redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/json', 'X-Goog-Api-Key': key } });
  };
  let durationKey, durationLoader;
  let avatarKey, avatarLoader, avatarExpires = 0, avatarRequests = 0;
  return {
    setup: openWindowsKeySetup,
    async configured() { return Boolean(await getKey()); },
    async search(query, preferences, signal) {
      const key = await getKey();
      if (!key) throw new Error('YOUTUBE_KEY_MISSING');
      // Existing bounded response parser rejects raw and JSON-escaped key echoes.
      const result = await fetchYouTubeResults({ query, preferences, signal, token: key, fetchImpl: privateFetch, timeoutMs: 8000 });
      // Share successful and failed lookups (including in-flight batches) across
      // searches. Rotate daily or when credentials change; never persist keys.
      if (key !== avatarKey || Date.now() >= avatarExpires) {
        avatarKey = key; avatarExpires = Date.now() + 86400000;
        avatarLoader = createChannelAvatarLoader({ token: key, fetchImpl: privateFetch, timeoutMs: 1500,
          maxBatches: 200, onRequest: () => { avatarRequests++; } });
      }
      if (!signal?.aborted) {
        const before = avatarRequests;
        const loading = avatarLoader(result.videos);
        result.requests += avatarRequests - before;
        await loading;
      }
      if (JSON.stringify(result).includes(key)) throw new Error('INVALID_RESPONSE');
      return result;
    },
    async durations(ids) {
      const key = await getKey();
      if (!key) throw new Error('YOUTUBE_KEY_MISSING');
      if (key !== durationKey) {
        durationKey = key;
        durationLoader = createVideoDurationLoader({ getToken: async () => key, fetchImpl: privateFetch });
      }
      return durationLoader(ids);
    },
  };
}
