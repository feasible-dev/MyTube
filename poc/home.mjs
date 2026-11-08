import { videoReference } from '../extension/video-reference.mjs';
import { validatePreferences } from '../extension/preferences.mjs';
import { validChannelAvatar } from '../extension/channel-avatar.mjs';
import { validVideoThumbnail } from '../extension/video-thumbnail.mjs';
import { syntheticProductionSignals, selectSearchColumns, uniqueVideos } from './model.mjs';
import { matchesQuickSubject } from '../extension/quick-relevance.mjs';

export const HOME_KEY = 'mytube.home.v1';
const HOME_DAY = 86400000;
const homeId = value => typeof value === 'string' && (/^[A-Za-z0-9_-]{11}$/.test(value) || value.startsWith('web:') && videoReference(value.slice(4))?.video_id === value);
const homeText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
export function emptyHome() { return { version: 1, enabled: true, topics: [], saved: [], hidden: [], refreshedAt: 0 }; }
export function homeVideo(v, now) {
  const external = v?.source === 'external_web', web = external || v?.source === 'youtube_web';
  if (external && (videoReference(v.source_url)?.video_id !== v.video_id || videoReference(v.source_url)?.platform !== v.platform)) return null;
  if (!v || !homeId(v.video_id) || !Number.isFinite(v.cachedAt) || v.cachedAt > now || now - v.cachedAt >= 30 * HOME_DAY
    || typeof v.title !== 'string' || typeof v.channel !== 'string' || (!web && !Number.isFinite(Date.parse(v.published_at)))
    || (web ? (v.duration_seconds !== null && !((v.duration_source === 'youtube_api' || external && v.duration_source === 'provider_metadata') && Number.isInteger(v.duration_seconds) && v.duration_seconds > 0 && v.duration_seconds <= 21600)) || v.published_at !== null : !Number.isInteger(v.duration_seconds) || v.duration_seconds < 1 || v.duration_seconds > 21600)
    || syntheticProductionSignals(v).length) return null;
  return { video_id: v.video_id, title: homeText(v.title, 500), channel: homeText(v.channel, 500),
    ...(/^UC[A-Za-z0-9_-]{22}$/.test(v.channel_id ?? '') ? { channel_id: v.channel_id } : {}),
    ...(typeof v.channel_url === 'string' ? { channel_url: homeText(v.channel_url, 250) } : {}),
    ...(external ? { platform: v.platform, channel_unknown: true } : {}),
    description: homeText(v.description, 1500), published_at: v.published_at, duration_seconds: v.duration_seconds,
    ...(web && (v.duration_source === 'youtube_api' || external && v.duration_source === 'provider_metadata') ? { duration_source: v.duration_source } : {}),
    views: Number.isSafeInteger(v.views) && v.views >= 0 ? v.views : null,
    ...(validChannelAvatar(v.channel_avatar) ? { channel_avatar: v.channel_avatar } : {}),
    ...(validVideoThumbnail(v.thumbnail_url, v.platform) ? { thumbnail_url: v.thumbnail_url } : {}),
    ...(['direct', 'adjacent', 'wildcard'].includes(v.discovery_stream) ? { discovery_stream: v.discovery_stream } : {}),
    audio_language: homeText(v.audio_language, 20), source: external ? 'external_web' : web ? 'youtube_web' : 'youtube_live', cachedAt: v.cachedAt,
    ...(web ? { source_url: external ? videoReference(v.source_url).url : `https://www.youtube.com/watch?v=${v.video_id}`, discovery_why: homeText(v.discovery_why, 200) } : {}),
    discovery_query: homeText(v.discovery_query, 150) };
}
export function cleanHome(value, now = Date.now()) {
  const result = emptyHome();
  if (value?.version !== 1) return result;
  result.enabled = value.enabled !== false;
  if (!result.enabled) return result;
  for (const t of (Array.isArray(value.topics) ? value.topics : []).slice(0, 8)) {
    if (!t || typeof t.label !== 'string' || !Array.isArray(t.queries) || !t.queries.length || !Number.isFinite(t.updatedAt)
      || t.updatedAt > now || now - t.updatedAt >= 180 * HOME_DAY) continue;
    let preferences;
    try { preferences = validatePreferences(t.preferences); } catch { continue; }
    const queries = t.queries.filter(q => typeof q === 'string' && q.length >= 2 && q.length <= 150 && !/[<>\x00-\x1f]/.test(q)).slice(0, 4);
    if (!queries.length) continue;
    result.topics.push({ label: homeText(t.label, 120), queries, preferences,
      subjects: Array.isArray(t.subjects) ? t.subjects.filter(s => typeof s === 'string' && s.length >= 2 && s.length <= 80).slice(0, 6) : [],
      uses: Number.isInteger(t.uses) ? Math.max(1, Math.min(t.uses, 100)) : 1, updatedAt: t.updatedAt,
      refreshedAt: Number.isFinite(t.refreshedAt) && t.refreshedAt <= now ? t.refreshedAt : 0,
      videos: (Array.isArray(t.videos) ? t.videos : []).slice(0, 40).map(v => homeVideo(v, now)).filter(Boolean) });
  }
  result.saved = (Array.isArray(value.saved) ? value.saved : []).filter(homeId).slice(-300);
  result.hidden = (Array.isArray(value.hidden) ? value.hidden : []).filter(homeId).slice(-300);
  result.refreshedAt = Number.isFinite(value.refreshedAt) && value.refreshedAt <= now ? value.refreshedAt : 0;
  return result;
}
export function loadHome(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(HOME_KEY);
    const value = raw && raw.length <= 1500000 ? cleanHome(JSON.parse(raw), now) : emptyHome();
    saveHome(storage, value); return value;
  } catch { return emptyHome(); }
}
export function saveHome(storage, home) {
  try { storage?.setItem(HOME_KEY, JSON.stringify(home)); } catch { /* Cache failure must not break search. */ }
}
export function rememberHome(home, result, now = Date.now()) {
  if (['chatgpt_web', 'youtube_api'].includes(result?.provider) && result.videos?.length) {
    // Store public titles, not the user's original dictation, as cache labels.
    const label = (result.videos.find(v => v.discovery_stream === 'direct') ?? result.videos[0]).title.slice(0, 120);
    result = { ...result, streams: { direct: { subjects: [label.slice(0, 80)], searches: [{ query: label, status: 'complete' }] } } };
  }
  if (result?.provisional_source === 'youtube' && result.quick_query) result = { ...result,
    videos: result.videos.filter(v => matchesQuickSubject(v, result.query ?? result.quick_query)), streams: {
    direct: { subjects: [], searches: [{ query: result.quick_query, status: 'complete' }] },
  } };
  if (!home.enabled || !result?.videos?.length || !result.streams?.direct) return home;
  const direct = result.streams.direct;
  const queries = (direct.searches ?? []).filter(q => q.status === 'complete').map(q => q.query).slice(-4);
  if (!queries.length) return home;
  const label = direct.subjects?.join(' / ').slice(0, 120) || queries[0].slice(0, 120);
  const previous = home.topics.find(t => t.label.toLowerCase() === label.toLowerCase());
  const selected = result.provider === 'youtube_api' ? selectSearchColumns(result.videos, true) : null;
  const cacheVideos = selected ? Array.from({ length: 8 }, (_, i) => [selected.direct[i], selected.related[i], selected.wildcard[i]]).flat().filter(Boolean) : result.videos;
  const fresh = cacheVideos.map(v => ({ ...v, cachedAt: now }));
  const merged = uniqueVideos([...fresh, ...(previous?.videos ?? [])]);
  const topic = { label, queries, subjects: direct.subjects ?? [], preferences: result.preferences,
    uses: (previous?.uses ?? 0) + 1, updatedAt: now, videos: merged.slice(0, 40) };
  return cleanHome({ ...home, topics: [topic, ...home.topics.filter(t => t !== previous)].slice(0, 8) }, now);
}
// Preserve saved picks, then interleave fresh and older discoveries.
export function mergeHomeRefresh(previous, incoming, savedIds, now = Date.now()) {
  const fresh = incoming.slice(0, 20).map(video => ({ ...video, cachedAt: now }));
  const saved = previous.filter(video => savedIds.has(video.video_id));
  const mixed = fresh.flatMap((video, index) => [video, previous[index]].filter(Boolean));
  return uniqueVideos([...saved, ...mixed, ...previous]).slice(0, 40);
}

export function homeTopics(home) {
  return [...home.topics].sort((a, b) => (b.uses + b.videos.filter(v => home.saved.includes(v.video_id)).length * 3)
    - (a.uses + a.videos.filter(v => home.saved.includes(v.video_id)).length * 3));
}
export function homePicks(home, now = Date.now()) {
  const seen = new Set(), channels = new Map(), recent = [], lasting = [], saved = [];
  const topics = homeTopics(cleanHome(home, now));
  // Round-robin topics so one favourite cannot monopolize the home page.
  for (let i = 0; i < 40; i++) for (const topic of topics) {
    const v = topic.videos[i];
    if (!v || seen.has(v.video_id) || home.hidden.includes(v.video_id) || syntheticProductionSignals(v).length) continue;
    seen.add(v.video_id);
    const row = { ...v, home_topic: topic.label };
    if (home.saved.includes(v.video_id)) saved.push(row);
    const channel = v.channel.toLowerCase();
    if ((channels.get(channel) ?? 0) >= 2) continue;
    channels.set(channel, (channels.get(channel) ?? 0) + 1);
    const age = now - Date.parse(v.published_at);
    (age >= 0 && age <= 30 * HOME_DAY ? recent : lasting).push(row);
  }
  return { recent: recent.slice(0, 18), lasting: lasting.slice(0, 18), saved };
}
export function cachedSearchPicks(home, intention, now = Date.now()) {
  const seen = new Set(), rows = [];
  for (const topic of cleanHome(home, now).topics) for (const v of topic.videos) {
    if (!seen.has(v.video_id) && !home.hidden.includes(v.video_id) && matchesQuickSubject(v, intention)) { seen.add(v.video_id); rows.push(v); }
  }
  return rows.slice(0, 36);
}
export function pastSearchPicks(home, now = Date.now()) {
  const clean = cleanHome(home, now), seen = new Set(clean.hidden), rows = [];
  const topics = clean.topics.sort((a, b) => b.updatedAt - a.updatedAt);
  for (let i = 0; i < 40 && rows.length < 8; i++) for (const topic of topics) {
    const video = topic.videos[i];
    if (!video || seen.has(video.video_id) || rows.length >= 8) continue;
    seen.add(video.video_id); rows.push({ ...video, home_topic: topic.label });
  }
  return rows;
}
