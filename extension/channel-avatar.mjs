// Shared by retrieval and rendering. Never load arbitrary provider-supplied URLs.
export function validChannelAvatar(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && ['yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname);
  } catch { return false; }
}
