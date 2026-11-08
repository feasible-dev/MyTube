export const CHANNEL_BLOCKS_KEY = 'mytube.blocked-channels';
function channelAliases(video) {
  if (video.source === 'external_web') return [];
  const aliases = [];
  if (/^UC[A-Za-z0-9_-]{22}$/.test(video.channel_id ?? '')) aliases.push(`id:${video.channel_id}`);
  try {
    const url = new URL(video.channel_url);
    if (url.protocol === 'https:' && ['youtube.com', 'www.youtube.com'].includes(url.hostname)) {
      const path = url.pathname.replace(/\/$/, '');
      if (/^\/channel\/UC[A-Za-z0-9_-]{22}$/.test(path)) aliases.push(`id:${path.slice(9)}`);
      else if (/^\/@[^/\s]{1,100}$/u.test(path)) aliases.push(`handle:${path.slice(2).normalize('NFKC').toLowerCase()}`);
    }
  } catch { /* Old cached entries have only a channel name. */ }
  const name = String(video.channel ?? '').normalize('NFKC').trim().toLowerCase();
  if (name && name.length <= 500) aliases.push(`name:${name}`);
  return [...new Set(aliases)];
}
export function isChannelBlocked(video, records) {
  const aliases = channelAliases(video);
  return records.some(record => record.aliases.some(alias => aliases.includes(alias)));
}
export function blockChannel(records, video) {
  const aliases = channelAliases(video);
  if (!aliases.length || isChannelBlocked(video, records)) return records;
  return [...records, { name: String(video.channel).slice(0, 500), aliases, addedAt: Date.now() }];
}
export function loadChannelBlocks(storage) {
  try {
    const raw = storage?.getItem(CHANNEL_BLOCKS_KEY);
    if (!raw || raw.length > 2000000) return [];
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.channels)) return [];
    return data.channels.slice(0, 2000).filter(row => typeof row?.name === 'string' && row.name.length <= 500
      && Array.isArray(row.aliases) && row.aliases.length <= 4
      && row.aliases.every(a => typeof a === 'string' && /^(id:UC[A-Za-z0-9_-]{22}|handle:[^\s]{1,100}|name:.{1,500})$/u.test(a)));
  } catch { return []; }
}
export function channelBlocksJSON(records) { return JSON.stringify({ version: 1, channels: records }, null, 2); }
export function saveChannelBlocks(storage, records) {
  try { storage?.setItem(CHANNEL_BLOCKS_KEY, channelBlocksJSON(records)); return Boolean(storage); }
  catch { return false; }
}
