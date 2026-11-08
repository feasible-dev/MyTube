import { SafeError, validateApiKey, validId, durationSeconds } from '../b1-youtube-candidates/core.mjs';
const fail = code => { throw new SafeError(code); };
const channelId = id => typeof id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(id);
const playlistId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(id);

// An isolated, fixed-origin read-only client. B1's hashed source files stay unchanged.
export function client(key, ledger, fetchImpl = fetch) {
  key = validateApiKey(key);
  const budgets = { videos: 4, channels: 1, playlistItems: 3 };
  return async (endpoint, params) => {
    if (!Object.hasOwn(budgets, endpoint)) fail('INVALID_ENDPOINT');
    if (Object.keys(params).some(p => !['part', 'id', 'playlistId', 'maxResults'].includes(p))) fail('INVALID_PARAMETER');
    if (ledger.filter(r => r.endpoint === endpoint).length >= budgets[endpoint]) fail('REQUEST_BUDGET_EXCEEDED');
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    url.search = new URLSearchParams(params).toString();
    const entry = { endpoint, http_status: null, response_bytes: 0 }; ledger.push(entry);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response, reader;
    try {
      response = await fetchImpl(url, { headers: { 'x-goog-api-key': key, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      entry.http_status = response.status;
      if (!response.ok) fail(`HTTP_${response.status}`);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail('INVALID_CONTENT_TYPE');
      if (!response.body) fail('MISSING_BODY');
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) fail('BODY_TOO_LARGE');
      reader = response.body.getReader(); const chunks = [];
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        entry.response_bytes += value.length;
        if (entry.response_bytes > 2 * 1024 * 1024) fail('BODY_TOO_LARGE');
        chunks.push(value);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.includes(key)) fail('CREDENTIAL_ECHO_REJECTED');
      let data; try { data = JSON.parse(body); } catch { fail('INVALID_JSON'); }
      if (!Array.isArray(data?.items) || data.items.length > 50) fail('INVALID_RESPONSE');
      return data.items;
    } catch (error) {
      if (error instanceof SafeError) throw error;
      fail(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {});
    }
  };
}

export async function sampleFeeds(seeds, intents, originalCandidates, request) {
  if (seeds.length !== 3 || seeds.some(s => !validId(s.video_id) || !intents.some(i => i.id === s.intent))) fail('INVALID_SEEDS');
  const ids = [...new Set(seeds.map(s => s.video_id))];
  const seedItems = await request('videos', { part: 'snippet', id: ids.join(',') });
  const seedChannels = new Map();
  for (const item of seedItems) {
    if (!ids.includes(item?.id) || seedChannels.has(item.id) || !channelId(item.snippet?.channelId)) fail('INVALID_SEED_RESPONSE');
    seedChannels.set(item.id, item.snippet.channelId);
  }
  if (seedChannels.size !== ids.length) fail('SEED_UNAVAILABLE');
  const channels = [...new Set(seedChannels.values())];
  const channelItems = await request('channels', { part: 'contentDetails', id: channels.join(',') });
  const uploads = new Map();
  for (const item of channelItems) {
    const uploadId = item?.contentDetails?.relatedPlaylists?.uploads;
    if (!channels.includes(item?.id) || uploads.has(item.id) || !playlistId(uploadId)) fail('INVALID_CHANNEL_RESPONSE');
    uploads.set(item.id, uploadId);
  }
  if (uploads.size !== channels.length) fail('CHANNEL_UNAVAILABLE');
  const feedIds = new Map(), allIds = new Set();
  for (const id of channels) {
    const items = await request('playlistItems', { part: 'contentDetails', playlistId: uploads.get(id), maxResults: '50' });
    const unique = new Set();
    for (const item of items) {
      const videoId = item?.contentDetails?.videoId;
      if (!validId(videoId)) fail('INVALID_PLAYLIST_VIDEO_ID');
      unique.add(videoId); allIds.add(videoId);
    }
    feedIds.set(id, [...unique]);
  }
  const collected = [...allIds], metadata = new Map();
  for (let offset = 0; offset < collected.length; offset += 50) {
    const batch = collected.slice(offset, offset + 50);
    const items = await request('videos', { part: 'snippet,contentDetails', id: batch.join(',') });
    for (const item of items) {
      if (!batch.includes(item?.id) || metadata.has(item.id)) fail('UNEXPECTED_VIDEO_ID');
      metadata.set(item.id, { video_id: item.id, duration_seconds: durationSeconds(item.contentDetails?.duration),
        live_status: ['none', 'live', 'upcoming'].includes(item.snippet?.liveBroadcastContent) ? item.snippet.liveBroadcastContent : 'unknown' });
    }
  }
  return { public_channels: channels.length, unique_playlist_video_ids: collected.length,
    missing_metadata_count: collected.length - metadata.size,
    samples: seeds.map(seed => {
      const intent = intents.find(i => i.id === seed.intent), ch = seedChannels.get(seed.video_id);
      const videos = feedIds.get(ch).filter(id => metadata.has(id)).map(id => metadata.get(id));
      const eligible = videos.filter(v => v.live_status === 'none' && Number.isFinite(v.duration_seconds)
        && v.duration_seconds >= intent.min_minutes * 60 && v.duration_seconds <= intent.max_minutes * 60);
      const originalIds = new Set(originalCandidates.filter(v => v.intent === intent.id).map(v => v.video_id));
      return { intent: intent.id, seed_video_id: seed.video_id, channel_id: ch,
        playlist_items: feedIds.get(ch).length, eligible_by_duration_and_live_status: eligible.length,
        eligible_not_in_original_theme_pool: eligible.filter(v => !originalIds.has(v.video_id)).length,
        videos, relevance: 'UNASSESSED' };
    }) };
}
