import { videoReference } from './video-reference.mjs';
import { validateWebVideos } from './web-discovery.mjs';
import { requestDiscoveryPlan } from './discovery.mjs';
import { LiveSearchError } from './youtube-live.mjs';
import { validVideoThumbnail } from './video-thumbnail.mjs';

export function validateWildcardVideos(value) {
  if (!Array.isArray(value?.videos) || value.videos.length > 8 || !Number.isInteger(value.searches) || value.searches < 1 || value.searches > 8) throw new LiveSearchError('INVALID_RESPONSE');
  if (value.search_details !== undefined && (!Array.isArray(value.search_details) || value.search_details.length > 16
    || value.search_details.some(row => typeof row?.query !== 'string' || !row.query.trim() || row.query.length > 400 || /[\x00-\x1f]/.test(row.query)
      || row.status !== 'complete' || !Array.isArray(row.platforms) || row.platforms.length > 6
      || row.platforms.some(p => !['YouTube', 'Vimeo', 'Dailymotion', 'BitChute', 'Rumble', 'Rutube', 'Odysee', 'Internet Archive'].includes(p))))) throw new LiveSearchError('INVALID_RESPONSE');
  const ids = new Set();
  for (const video of value.videos) {
    const ref = videoReference(video?.source_url);
    if (!ref || ref.video_id !== video.video_id || ids.has(video.video_id) || video.discovery_stream !== 'wildcard') throw new LiveSearchError('INVALID_RESPONSE');
    ids.add(video.video_id);
    if (video.thumbnail_url !== undefined && !validVideoThumbnail(video.thumbnail_url, ref.platform)) throw new LiveSearchError('INVALID_RESPONSE');
    if (ref.platform === 'YouTube') validateWebVideos({ videos: [video], searches: value.searches });
    else if (video.source !== 'external_web' || video.platform !== ref.platform || video.source_url !== ref.url
      || video.channel !== ref.platform || video.channel_unknown !== true
      || typeof video.title !== 'string' || !video.title.trim() || video.title.length > 500
      || typeof video.discovery_why !== 'string' || video.discovery_why.length > 200
      || (video.duration_seconds !== null && !(video.duration_source === 'provider_metadata' && Number.isInteger(video.duration_seconds) && video.duration_seconds > 0 && video.duration_seconds <= 21600)) || video.views !== null || video.published_at !== null) throw new LiveSearchError('INVALID_RESPONSE');
  }
  return value;
}
export function requestWildcards(intention, signal, preferences, onProgress, watch, onWaiting, fetchImpl = globalThis.fetch) {
  return requestDiscoveryPlan(intention, signal, fetchImpl, watch, preferences, undefined, validateWildcardVideos, onProgress, onWaiting, false, true);
}
