import { videoReference } from './video-reference.mjs';
import { validVideoThumbnail } from './video-thumbnail.mjs';

// Fixed provider endpoints or canonical public watch pages; never fetch embed HTML,
// redirects, cookies, credentials, or the returned image on the connector.
export async function externalPreview(video, signal, fetchImpl = globalThis.fetch) {
  const ref = videoReference(video.source_url);
  if (!ref || ref.video_id !== video.video_id || ref.platform === 'YouTube') return {};
  const endpoint = { Vimeo: 'https://vimeo.com/api/oembed.json',
    Dailymotion: 'https://www.dailymotion.com/services/oembed', Rutube: 'https://rutube.ru/api/oembed/',
    Rumble: 'https://rumble.com/api/Media/oembed.json' }[ref.platform];
  const url = endpoint ? new URL(endpoint) : new URL(ref.url);
  if (endpoint) { url.searchParams.set('url', ref.url); url.searchParams.set('format', 'json'); url.searchParams.set('maxwidth', '640'); }
  const targets = ref.platform === 'Dailymotion'
    ? [[`https://api.dailymotion.com/video/${new URL(ref.url).pathname.split('/')[2]}?fields=thumbnail_url,duration`, true], [url.href, true]]
    : ref.platform === 'Rutube' ? [[`https://rutube.ru/api/video/${new URL(ref.url).pathname.split('/')[2]}/`, true], [url.href, true]]
    : ref.platform === 'Internet Archive' ? [[`https://archive.org/metadata/${new URL(ref.url).pathname.split('/')[2]}`, true]]
    : [[url.href, Boolean(endpoint)], ...(ref.platform === 'Rumble' ? [[ref.url, false]] : [])];
  let result = {};
  for (const [target, json] of targets) {
    if (signal?.aborted) break;
    result = { ...result, ...await readPreview(target, json, ref.platform, signal, fetchImpl) };
    if (result.preview_unavailable) return { preview_unavailable: true };
    if (result.thumbnail_url && result.duration_seconds) break;
  }
  if (result.thumbnail_url) delete result.preview_unavailable;
  return result;
}

async function readPreview(target, json, platform, signal, fetchImpl) {
  let reader;
  try {
    const response = await fetchImpl(target, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(6000)]) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return [404, 410].includes(response.status) ? { preview_unavailable: true } : {};
    }
    const type = response.headers.get('content-type') ?? '';
    if (!(json ? /^application\/json/i : /^text\/html/i).test(type)) { await response.body.cancel(); return {}; }
    reader = response.body.getReader(); let text = '', bytes = 0; const decoder = new TextDecoder();
    while (true) { const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 524288) return {}; text += decoder.decode(value, { stream: true }); }
    text += decoder.decode();
    let thumbnail, duration;
    if (json) {
      const metadata = JSON.parse(text); thumbnail = metadata.thumbnail_url; duration = Number(metadata.duration);
      if (platform === 'Internet Archive') {
        if (metadata.metadata?.mediatype !== 'movies' || metadata.is_dark || metadata.metadata?.accessrestricted === 'true') return { preview_unavailable: true };
        const id = new URL(target).pathname.split('/')[2];
        thumbnail = `https://archive.org/services/img/${id}`;
        const parts = String(metadata.metadata.runtime ?? '').split(':').map(Number);
        if (parts.length >= 2 && parts.length <= 3 && parts.every(Number.isFinite)) duration = parts.reduce((n, v) => n * 60 + v, 0);
      }
    }
    else for (const tag of text.match(/<meta\s[^>]*>/gi) ?? []) {
      const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]));
      if (['og:image', 'twitter:image'].includes(attrs.property ?? attrs.name)) {
        const candidate = attrs.content?.replaceAll('&amp;', '&');
        if (validVideoThumbnail(candidate, platform)) thumbnail = candidate;
      }
      if (['video:duration', 'og:video:duration'].includes(attrs.property ?? attrs.name)) { duration = Number(attrs.content);
      }
    }
    return { ...(validVideoThumbnail(thumbnail, platform) ? { thumbnail_url: thumbnail } : {}),
      ...(Number.isInteger(duration) && duration > 0 && duration <= 21600 ? { duration_seconds: duration, duration_source: 'provider_metadata' } : {}) };
  } catch { return {}; }
  finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
}
