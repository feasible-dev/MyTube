import { requestJson, normalizeYouTubeVideos, LiveSearchError } from './youtube-live.mjs';
import { validatePreferences } from './preferences.mjs';
import { validChannelAvatar } from './channel-avatar.mjs';

// Ten subscriptions per explicit page; five latest uploads each. No search.list,
// no automatic crawling of the user's entire account, and no token persistence.
export async function fetchSubscriptionPage({ token, pageToken, signal, onBatch = () => {}, preferences,
  fetchImpl = globalThis.fetch, timeoutMs = 12000 }) {
  if (pageToken && !/^[A-Za-z0-9_=-]{1,1024}$/.test(pageToken)) throw new LiveSearchError('INVALID_RESPONSE');
  const get = (path, params, page = false) => requestJson(path, params, token, signal, fetchImpl, timeoutMs, page);
  const page = await get('subscriptions', { part: 'snippet', mine: 'true', maxResults: '10', order: 'alphabetical',
    ...(pageToken ? { pageToken } : {}), fields: 'nextPageToken,items/snippet/resourceId/channelId' }, true);
  const ids = [...new Set(page.items.map(r => r.snippet?.resourceId?.channelId))];
  if (ids.some(id => !/^UC[A-Za-z0-9_-]{22}$/.test(id ?? ''))) throw new LiveSearchError('INVALID_RESPONSE');
  if (!ids.length) return { videos: [], nextPageToken: page.nextPageToken, channels: 0, failed: 0 };
  const channels = await get('channels', { part: 'contentDetails,snippet', id: ids.join(','),
    fields: 'items(id,contentDetails/relatedPlaylists/uploads,snippet/thumbnails/default/url)' });
  if (channels.some(c => !ids.includes(c.id))) throw new LiveSearchError('INVALID_RESPONSE');
  const chosen = validatePreferences(preferences), videos = [];
  let index = 0, failed = 0;
  async function worker() {
    while (index < channels.length) {
      const channel = channels[index++], playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(playlistId ?? '')) { failed++; continue; }
      try {
        const uploads = await get('playlistItems', { part: 'contentDetails', playlistId, maxResults: '5', fields: 'items/contentDetails/videoId' });
        const videoIds = [...new Set(uploads.map(v => v.contentDetails?.videoId))];
        if (videoIds.some(id => !/^[A-Za-z0-9_-]{11}$/.test(id ?? ''))) throw new LiveSearchError('INVALID_RESPONSE');
        if (!videoIds.length) continue;
        const items = await get('videos', { part: 'snippet,contentDetails,statistics', id: videoIds.join(','),
          fields: 'items(id,snippet(title,channelTitle,channelId,defaultAudioLanguage,description,publishedAt,liveBroadcastContent),contentDetails/duration,statistics/viewCount)' });
        const batch = normalizeYouTubeVideos(items, videoIds, chosen).filter(v => v.channel_id === channel.id)
          .map(v => ({ ...v, cachedAt: Date.now(), ...(validChannelAvatar(channel.snippet?.thumbnails?.default?.url)
            ? { channel_avatar: channel.snippet.thumbnails.default.url } : {}) }));
        videos.push(...batch); if (!signal?.aborted) onBatch(batch);
      } catch (error) {
        if (signal?.aborted || ['SIGN_IN_REQUIRED', 'QUOTA_EXCEEDED', 'ACCESS_OR_QUOTA_DENIED', 'RATE_LIMITED'].includes(error.code)) throw error;
        failed++;
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { videos, nextPageToken: page.nextPageToken, channels: ids.length, failed };
}
