// Public image hosts only; never accept arbitrary model-supplied image URLs.
export const THUMBNAIL_ORIGINS = ['https://i.vimeocdn.com', 'https://*.dmcdn.net', 'https://*.rutube.ru', 'https://pic.rtbcdn.ru',
  'https://*.rutubelist.ru', 'https://*.1a-1791.com', 'https://1a-1791.com', 'https://*.rumble.cloud', 'https://*.bitchute.com', 'https://thumbnails.odycdn.com', 'https://thumbnails.lbry.com', 'https://archive.org'];
export function validVideoThumbnail(value, platform) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f]/.test(value)) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false;
    const hosts = { Vimeo: ['i.vimeocdn.com'], Dailymotion: ['dmcdn.net'], Rutube: ['rutube.ru', 'rutubelist.ru', 'pic.rtbcdn.ru'],
      Rumble: ['1a-1791.com', 'rumble.cloud'], BitChute: ['bitchute.com'], Odysee: ['thumbnails.odycdn.com', 'thumbnails.lbry.com'], 'Internet Archive': ['archive.org'] }[platform] ?? [];
    return hosts.some(host => u.hostname === host || platform !== 'Vimeo' && u.hostname.endsWith('.' + host));
  } catch { return false; }
}
