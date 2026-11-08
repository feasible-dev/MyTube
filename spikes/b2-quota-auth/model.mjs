export const documentedLimits = { search: 100, other: 10000 };
const integer = n => Number.isSafeInteger(n) && n >= 0;

export function estimateSearch({ users, intentionsPerDay, queriesPerIntention = 4, metadataPerIntention = 2, cacheHitRate = 0 }) {
  if (![users, intentionsPerDay, queriesPerIntention, metadataPerIntention].every(integer)
    || !Number.isFinite(cacheHitRate) || cacheHitRate < 0 || cacheHitRate > 1) throw new Error('INVALID_ASSUMPTION');
  // Hypothetical whole-intention cache reuse, rounded upward; not an observed hit rate.
  const fresh = Math.ceil(users * intentionsPerDay * (1 - cacheHitRate));
  return { search: fresh * queriesPerIntention, other: fresh * metadataPerIntention };
}

export function estimateChannels({ users, channelsPerUser, refreshesPerDay = 1, playlistPages = 1,
  metadataVideosPerChannel = 50, cachedChannelIds = false }) {
  if (![users, channelsPerUser, refreshesPerDay, playlistPages, metadataVideosPerChannel].every(integer)
    || typeof cachedChannelIds !== 'boolean') throw new Error('INVALID_ASSUMPTION');
  const subscriptions = Math.ceil(channelsPerUser / 50);
  const channelLookup = cachedChannelIds ? 0 : Math.ceil(channelsPerUser / 50);
  const playlist = channelsPerUser * playlistPages;
  const metadata = Math.ceil(channelsPerUser * metadataVideosPerChannel / 50);
  return { search: 0, other: users * refreshesPerDay * (subscriptions + channelLookup + playlist + metadata) };
}

export function capacity(cost, reserve = 0.2) {
  if (![cost.search, cost.other].every(integer) || !Number.isFinite(reserve) || reserve < 0 || reserve >= 1) throw new Error('INVALID_ASSUMPTION');
  return { ...cost, fits_documented_defaults: cost.search <= documentedLimits.search && cost.other <= documentedLimits.other,
    fits_with_reserve: cost.search <= Math.floor(documentedLimits.search * (1 - reserve))
      && cost.other <= Math.floor(documentedLimits.other * (1 - reserve)) };
}
