import { validatePreferences, languageMatches } from './preferences.mjs';
import { validChannelAvatar } from './channel-avatar.mjs';

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export class LiveSearchError extends Error {
  constructor(code) { super(code); this.name = 'LiveSearchError'; this.code = code; }
}
function fail(code) { throw new LiveSearchError(code); }
export async function googleResponseFailure(response) {
  let code = response.status === 401 ? 'SIGN_IN_REQUIRED' : response.status === 403 ? 'ACCESS_OR_QUOTA_DENIED'
    : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE';
  // Read only bounded, fixed reason fields. Never expose Google's message/body.
  if ([403, 429].includes(response.status) && response.body) {
    const reader = response.body.getReader(); let text = '', size = 0;
    try {
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 8192) break;
        text += decoder.decode(value, { stream: true });
      }
      if (size <= 8192) {
        const reasons = JSON.parse(text)?.error?.errors?.map(e => e?.reason) ?? [];
        if (reasons.some(r => ['quotaExceeded', 'dailyLimitExceeded'].includes(r))) code = 'QUOTA_EXCEEDED';
        else if (reasons.some(r => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(r))) code = 'RATE_LIMITED';
      }
    } catch { /* Keep fixed HTTP category. */ }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } else await response.body?.cancel().catch(() => {});
  const error = new LiveSearchError(code), retry = response.headers.get('retry-after');
  const ms = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : NaN;
  error.retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : null;
  return error;
}
function validToken(token) {
  return typeof token === 'string' && token.length >= 16 && token.length <= 8192 && /^[-A-Za-z0-9._~+/]+=*$/.test(token);
}
function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id); }
function boundedText(value, max) {
  if (typeof value !== 'string' || value.length > max) fail('INVALID_RESPONSE');
  return value;
}
function seconds(value) {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m || !m.slice(1).some(v => v !== undefined)) return null;
  const n = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export async function requestJson(endpoint, params, token, signal, fetchImpl, timeoutMs, page = false) {
  if (!validToken(token)) fail('SIGN_IN_REQUIRED');
  if (signal?.aborted) fail('CANCELLED');
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.search = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let response, reader;
  try {
    response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!response.ok) throw await googleResponseFailure(response);
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) fail('INVALID_RESPONSE');
    if (Number(response.headers.get('content-length')) > 2097152) fail('RESPONSE_TOO_LARGE');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let length = 0, body = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2097152) fail('RESPONSE_TOO_LARGE');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    if (body.includes(token)) fail('INVALID_RESPONSE');
    const json = JSON.parse(body);
    if (JSON.stringify(json).includes(token)) fail('INVALID_RESPONSE');
    if (!json || !Array.isArray(json.items) || json.items.length > 50) fail('INVALID_RESPONSE');
    if (page) {
      if (json.nextPageToken !== undefined && (typeof json.nextPageToken !== 'string' || !/^[A-Za-z0-9_=-]{1,1024}$/.test(json.nextPageToken))) fail('INVALID_RESPONSE');
      return { items: json.items, nextPageToken: json.nextPageToken ?? null };
    }
    return json.items;
  } catch (error) {
    if (signal?.aborted) fail('CANCELLED');
    if (controller.signal.aborted) fail('TIMEOUT');
    if (error instanceof LiveSearchError) throw error;
    fail('REQUEST_FAILED');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response?.body?.cancel().catch(() => {});
  }
}

// Optional duration enrichment uses existing authorization only, never search.list.
// Cache pending/failed IDs and stop after any access failure instead of prompting or retrying.
export function createVideoDurationLoader({ getToken, fetchImpl = globalThis.fetch, timeoutMs = 4000 }) {
  const cache = new Map(); let unavailable = false, batches = 0;
  return async ids => {
    if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !validId(id))) fail('INVALID_RESPONSE');
    const unique = [...new Set(ids)], missing = unique.filter(id => !cache.has(id));
    if (missing.length && !unavailable && batches < 12) {
      batches++;
      const pending = (async () => {
        try {
          const token = await getToken(); if (!validToken(token)) fail('SIGN_IN_REQUIRED');
          const items = await requestJson('videos', { part: 'contentDetails,snippet', id: missing.join(','),
            fields: 'items(id,contentDetails/duration,snippet/liveBroadcastContent)' }, token, undefined, fetchImpl, timeoutMs);
          const found = new Map(), seen = new Set();
          for (const item of items) {
            if (!missing.includes(item?.id) || seen.has(item.id)) fail('INVALID_RESPONSE');
            seen.add(item.id);
            const duration = seconds(item.contentDetails?.duration);
            if (item.snippet?.liveBroadcastContent === 'none' && Number.isInteger(duration) && duration > 0 && duration <= 21600) found.set(item.id, duration);
          }
          return found;
        } catch { unavailable = true; return new Map(); }
      })();
      for (const id of missing) cache.set(id, pending.then(found => found.get(id) ?? null));
    }
    return (await Promise.all(unique.map(async id => ({ video_id: id, duration_seconds: await cache.get(id) })))).filter(v => Number.isInteger(v.duration_seconds));
  };
}

// Per-discovery cache also shares pending lookups across simultaneous columns.
// Avatars are optional: failure never discards search results or retries a batch.
export function createChannelAvatarLoader({ token, signal, fetchImpl = globalThis.fetch, timeoutMs = 3000, onRequest = () => {}, maxBatches = 12 }) {
  const cache = new Map();
  let batches = 0;
  return async videos => {
    if (signal?.aborted) return false;
    const ids = [...new Set(videos.map(v => v.channel_id).filter(id => /^UC[A-Za-z0-9_-]{22}$/.test(id ?? '')))];
    const missing = ids.filter(id => !cache.has(id));
    for (let offset = 0; offset < missing.length && batches < maxBatches; offset += 50) {
      const batch = missing.slice(offset, offset + 50); batches++; onRequest();
      const pending = requestJson('channels', { part: 'snippet', id: batch.join(','), maxResults: '50',
        fields: 'items(id,snippet/thumbnails/default/url)' }, token, signal, fetchImpl, timeoutMs)
        .then(items => {
          const found = new Map();
          for (const item of items) {
            if (!batch.includes(item?.id) || found.has(item.id)) fail('INVALID_RESPONSE');
            const url = item.snippet?.thumbnails?.default?.url;
            found.set(item.id, validChannelAvatar(url) ? url : null);
          }
          return found;
        }).catch(() => new Map());
      for (const id of batch) cache.set(id, pending.then(found => found.get(id) ?? null));
    }
    const found = new Map(await Promise.all(ids.map(async id => [id, await cache.get(id)])));
    if (signal?.aborted) return false;
    let changed = false;
    for (const video of videos) {
      const url = found.get(video.channel_id);
      if (url && video.channel_avatar !== url) { video.channel_avatar = url; changed = true; }
    }
    return changed;
  };
}

// One search page + one metadata batch, no pagination, redirects, or retries.
export async function fetchYouTubeResults({ query, token, signal, fetchImpl = globalThis.fetch, timeoutMs = 20000, preferences, relevanceLanguage, recent = false }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) fail('INVALID_QUERY');
  if (!validToken(token)) fail('SIGN_IN_REQUIRED');
  const chosen = validatePreferences(preferences);
  const language = relevanceLanguage ?? chosen.languages[0];
  if (!chosen.languages.includes(language)) fail('INVALID_PREFERENCES');
  const search = await requestJson('search', { part: 'snippet', type: 'video', q: query.trim(),
    maxResults: '50', order: 'relevance', ...(recent ? { publishedAfter: new Date(Date.now() - 30 * 86400000).toISOString() } : {}), ...(chosen.minMinutes >= 20 ? { videoDuration: 'long' } : {}), relevanceLanguage: language, fields: 'items(id/videoId)' }, token, signal, fetchImpl, timeoutMs);
  const ids = [];
  for (const item of search) {
    if (!validId(item?.id?.videoId)) fail('INVALID_RESPONSE');
    if (!ids.includes(item.id.videoId)) ids.push(item.id.videoId);
  }
  if (signal?.aborted) fail('CANCELLED');
  if (!ids.length) return { query: query.trim(), fetched_at: new Date().toISOString(), videos: [], search_results: 0, requests: 1 };
  const items = await requestJson('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(','),
    fields: 'items(id,snippet(title,channelTitle,channelId,defaultAudioLanguage,description,publishedAt,liveBroadcastContent),contentDetails/duration,statistics/viewCount)' }, token, signal, fetchImpl, timeoutMs);
  const videos = normalizeYouTubeVideos(items, ids, chosen);
  if (signal?.aborted) fail('CANCELLED');
  return { query: query.trim(), fetched_at: new Date().toISOString(),
    videos: videos.sort((a, b) => a.provider_rank - b.provider_rank), search_results: ids.length, requests: 2 };
}

export function normalizeYouTubeVideos(items, ids, chosen = validatePreferences()) {
  const seen = new Set(), videos = [];
  for (const item of items) {
    if (!validId(item?.id) || !ids.includes(item.id) || seen.has(item.id)) fail('INVALID_RESPONSE');
    seen.add(item.id);
    const duration = seconds(item.contentDetails?.duration);
    if (item.snippet?.liveBroadcastContent !== 'none' || duration === null || duration < chosen.minMinutes * 60 || duration > chosen.maxMinutes * 60) continue;
    const audioLanguage = item.snippet.defaultAudioLanguage;
    if (audioLanguage !== undefined && (typeof audioLanguage !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(audioLanguage))) fail('INVALID_RESPONSE');
    if (!languageMatches(audioLanguage, chosen.languages)) continue;
    const published = boundedText(item.snippet.publishedAt, 40);
    if (!Number.isFinite(Date.parse(published))) fail('INVALID_RESPONSE');
    const views = /^\d+$/.test(item.statistics?.viewCount ?? '') ? Number(item.statistics.viewCount) : null;
    videos.push({ video_id: item.id, title: boundedText(item.snippet.title, 500),
      channel: boundedText(item.snippet.channelTitle, 500),
      ...(audioLanguage ? { audio_language: audioLanguage } : {}),
      ...(/^UC[A-Za-z0-9_-]{22}$/.test(item.snippet.channelId ?? '') ? { channel_id: item.snippet.channelId } : {}), description: boundedText(item.snippet.description ?? '', 10000),
      published_at: published, duration_seconds: duration, views: Number.isSafeInteger(views) && views >= 0 ? views : null,
      source: 'youtube_live', provider_rank: ids.indexOf(item.id) + 1 });
  }
  return videos;
}

export async function getGoogleToken(api, interactive) {
  if (typeof api?.identity?.getAuthToken !== 'function') fail('BROWSER_AUTH_UNSUPPORTED');
  let result;
  try { result = await api.identity.getAuthToken({ interactive, enableGranularPermissions: true, scopes: [YOUTUBE_SCOPE] }); }
  catch { fail('GOOGLE_SIGN_IN_FAILED'); }
  if (!validToken(result?.token) || !Array.isArray(result?.grantedScopes) || !result.grantedScopes.includes(YOUTUBE_SCOPE)) fail('REQUIRED_SCOPE_MISSING');
  return result.token;
}
