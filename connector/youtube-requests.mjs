import { validatePreferences } from '../extension/preferences.mjs';

// Only these typed operations can reach the local YouTube adapter.
// null preserves the HTTP layer's INVALID_REQUEST response; preference errors
// keep their existing, separately allowlisted error code.
export function parseYouTubeRequest(path, body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') return null;
  if (path === '/youtube/status') return Object.keys(body).length ? null : { type: 'status' };
  if (path === '/youtube/setup') return Object.keys(body).length ? null : { type: 'setup' };
  if (path === '/youtube/search') {
    if (!Object.hasOwn(body, 'query') || Object.keys(body).some(key => !['query', 'preferences'].includes(key))
      || typeof body.query !== 'string' || !body.query.trim() || body.query.length > 300 || /[\x00-\x1f]/.test(body.query)) return null;
    return { type: 'search', query: body.query, preferences: validatePreferences(body.preferences) };
  }
  if (path === '/youtube/durations') {
    if (Object.keys(body).length !== 1 || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 50
      || body.ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id))) return null;
    return { type: 'durations', ids: body.ids };
  }
  return null;
}

export async function executeYouTubeRequest(operation, youtube, signal) {
  switch (operation.type) {
    case 'setup': return youtube.setup();
    case 'status': return { configured: await youtube.configured() };
    case 'search': return youtube.search(operation.query, operation.preferences, signal);
    case 'durations': return { videos: await youtube.durations(operation.ids) };
    default: throw new Error('INVALID_REQUEST');
  }
}
