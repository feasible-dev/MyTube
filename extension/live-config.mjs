import { THUMBNAIL_ORIGINS } from './video-thumbnail.mjs';
const PREVIEW_ORIGINS = ['https://vimeo.com', 'https://www.dailymotion.com', 'https://api.dailymotion.com', 'https://rutube.ru', 'https://rumble.com', 'https://www.bitchute.com', 'https://odysee.com', 'https://archive.org'];
export function readClientId(config) {
  if (!config || Object.keys(config).some(k => k !== 'client_id')) throw new Error('Only a public client_id is allowed');
  if (config.client_id === null) return null;
  if (typeof config.client_id !== 'string' || !/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.client_id)) throw new Error('Invalid public Google client ID');
  return config.client_id;
}
export function liveManifestSettings(clientId, target) {
  const enabled = target === 'brave' || target === 'firefox';
  const policy = `default-src 'none'; script-src 'self'; style-src 'self'; img-src data:${enabled ? ' https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com ' + THUMBNAIL_ORIGINS.join(' ') : ''}; connect-src ${enabled ? 'https://www.googleapis.com http://127.0.0.1:43817 ' + PREVIEW_ORIGINS.join(' ') : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return { policy, additions: enabled ? {
    host_permissions: ['https://www.googleapis.com/*', 'http://127.0.0.1/*', ...PREVIEW_ORIGINS.map(origin => origin + '/*')],
    ...(clientId && target === 'brave' ? { permissions: ['identity'], oauth2: { client_id: clientId, scopes: ['https://www.googleapis.com/auth/youtube.readonly'] } } : {}),
  } : {} };
}
