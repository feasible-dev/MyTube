// Only canonical public watch pages become clickable cards. No model-provided
// URL becomes a generic fetch target; preview retrieval uses provider boundaries.
export function videoReference(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.replace(/^www\./, ''), path = url.pathname;
    let id;
    if (['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
      id = host === 'youtu.be' ? path.slice(1) : path === '/watch' ? url.searchParams.get('v') : null;
      return /^[A-Za-z0-9_-]{11}$/.test(id ?? '') ? { video_id: id, platform: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` } : null;
    }
    let canonical, platform;
    if (host === 'vimeo.com' && /^\/[0-9]{1,14}\/?$/.test(path)) { canonical = `https://vimeo.com/${path.split('/')[1]}`; platform = 'Vimeo'; }
    if (host === 'rumble.com' && /^\/v[a-z0-9]+-[a-z0-9-]+\.html$/i.test(path)) { canonical = `https://rumble.com${path}`; platform = 'Rumble'; }
    if (['bitchute.com', 'old.bitchute.com', 'api.bitchute.com'].includes(host) && /^\/video\/[A-Za-z0-9_-]{1,80}\/?$/.test(path)) { canonical = `https://www.bitchute.com/video/${path.split('/')[2]}`; platform = 'BitChute'; }
    if (host === 'dailymotion.com' && /^\/video\/[A-Za-z0-9]{1,30}\/?$/.test(path)) { canonical = `https://www.dailymotion.com/video/${path.split('/')[2]}`; platform = 'Dailymotion'; }
    if (host === 'rutube.ru' && /^\/video\/[a-f0-9]{32}\/?$/i.test(path)) { canonical = `https://rutube.ru/video/${path.split('/')[2].toLowerCase()}/`; platform = 'Rutube'; }
    if (host === 'odysee.com' && /^\/@[^/\s]{1,160}\/[^/\s]{1,250}:[a-f0-9]{1,40}\/?$/i.test(path)) { canonical = `https://odysee.com${path.replace(/\/$/, '')}`; platform = 'Odysee'; }
    if (host === 'archive.org' && /^\/details\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/?$/.test(path)) { canonical = `https://archive.org/details/${path.split('/')[2]}`; platform = 'Internet Archive'; }
    return canonical ? { video_id: `web:${canonical}`, platform, url: canonical } : null;
  } catch { return null; }
}

// Verified external discoveries precede the YouTube fallback; rotate platforms.
export function prioritizeExternal(videos) {
  const groups = new Map();
  const platforms = ['BitChute', 'Rumble', 'Rutube', 'Odysee', 'Internet Archive', 'Vimeo', 'Dailymotion'];
  for (const p of platforms) groups.set(p, videos.filter(v => v.platform === p));
  const result = [];
  for (let i = 0; [...groups.values()].some(g => i < g.length); i++) for (const g of groups.values()) if (g[i]) result.push(g[i]);
  return result.concat(videos.filter(v => !platforms.includes(v.platform)));
}
