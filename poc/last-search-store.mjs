import { homeVideo } from './home.mjs';
import { validatePreferences } from '../extension/preferences.mjs';

export const LAST_SEARCH_KEY = 'mytube.last-search.v1';
function cleanLastSearch(value, now) {
  if (value?.version !== 1 || !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt >= 30 * 86400000
    || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 6000 || !Array.isArray(value.videos)) return null;
  let preferences;
  try { preferences = validatePreferences(value.preferences); } catch { return null; }
  const videos = value.videos.slice(0, 150).map(v => homeVideo(v, now)).filter(Boolean);
  if (!videos.length) return null;
  const ids = new Set(videos.map(v => v.video_id));
  const order = Object.fromEntries(['direct', 'related', 'wildcard'].map(column => [column,
    [...new Set((Array.isArray(value.order?.[column]) ? value.order[column] : []).filter(id => ids.has(id)))].slice(0, 50)]));
  return { version: 1, savedAt: value.savedAt, query: value.query, preferences, videos, order,
    provider: value.provider === 'youtube_api' ? 'youtube_api' : 'chatgpt_web',
    interrupted: value.interrupted === true,
    limit: Number.isInteger(value.limit) ? Math.max(8, Math.min(56, value.limit)) : 8 };
}
export function clearLastSearch(storage) {
  try { storage?.setItem(LAST_SEARCH_KEY, 'null'); } catch { /* Storage can be unavailable. */ }
}
export function loadLastSearch(storage, enabled, now = Date.now()) {
  if (!enabled) { clearLastSearch(storage); return null; }
  try {
    const raw = storage?.getItem(LAST_SEARCH_KEY);
    return raw && raw.length <= 1500000 ? cleanLastSearch(JSON.parse(raw), now) : null;
  } catch { return null; }
}
export function saveLastSearch(storage, value, enabled, now = Date.now()) {
  if (!enabled) { clearLastSearch(storage); return; }
  try {
    const snapshot = cleanLastSearch({ ...value, version: 1, savedAt: now,
      videos: value.videos.map(v => ({ ...v, cachedAt: v.cachedAt ?? now })) }, now);
    if (snapshot) storage?.setItem(LAST_SEARCH_KEY, JSON.stringify(snapshot));
  } catch { /* Cache failure must never break a live search. */ }
}
