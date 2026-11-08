import { isChannelBlocked } from './channel-blocks.mjs';
import { videoReference, prioritizeExternal } from '../extension/video-reference.mjs';
export const STREAMS = ['direct', 'adjacent', 'wildcard'];

// First occurrence wins: callers order sources by their intended priority.
export function uniqueVideos(videos) {
  const seen = new Set();
  return videos.filter(video => {
    if (seen.has(video.video_id)) return false;
    seen.add(video.video_id); return true;
  });
}
export function detectLiveStatus(bridge, api, protocol) {
  if (!['chrome-extension:', 'moz-extension:'].includes(protocol)) {
    return { ready: false, reason: 'EXTENSION_REQUIRED', extensionId: null, version: null };
  }
  try {
    const manifest = api?.runtime?.getManifest?.();
    const info = { extensionId: api?.runtime?.id ?? null, version: manifest?.version ?? null,
      clientConfigured: Boolean(manifest?.oauth2?.client_id) };
    if (typeof bridge?.status !== 'function') return { ...info, ready: false, reason: 'LIVE_MODULE_UNAVAILABLE' };
    return { ...info, ...bridge.status() };
  } catch {
    return { ready: false, reason: 'RELOAD_REQUIRED', extensionId: null, version: null };
  }
}
export function videoUrl(id) {
  if (typeof id === 'string' && id.startsWith('web:')) {
    const ref = videoReference(id.slice(4));
    if (ref && ref.video_id === id) return ref.url;
  }
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('INVALID_VIDEO_ID');
  return `https://www.youtube.com/watch?v=${id}`;
}
export function youtubeSearchUrl(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('INVALID_QUERY');
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', query.trim());
  return url.href;
}
export function durationLabel(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
}
// Metadata hints only: a channel name does not establish institutional ownership.
export function institutionalSignals(video) {
  const signals = [];
  if (/\b(university|universities|college|academy|institute|institution|museum|royal society|national archives|national laboratory|war college)\b/i.test(video.channel ?? '')
      || /^UW Video$/i.test(video.channel ?? '')) signals.push('institution-like channel name');
  if (/\b(lecture|lectures|seminar|conference|symposium|keynote|colloquium|presentation|presentations)\b/i.test(video.title ?? '')) signals.push('lecture or presentation format');
  if (/\b(hearing|hearings|testimony|proceedings|inquiry|commission report|team report|full trial|trial proceedings|court session)\b/i.test(video.title ?? '')) signals.push('hearing or primary-record format');
  if (/\b(PBS|BBC|ARTE)\b/i.test(video.channel ?? '')) signals.push('public-broadcaster-like channel name');
  return signals;
}
// Conservative disclosure matching, not an AI detector. Do not infer synthetic
// production from thumbnails, low view counts or a discussion ABOUT AI.
export function syntheticProductionSignals(video) {
  const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const title = normalize(video.title);
  const negated = text => /\b(no|not|without|never|sans|pas|aucun|aucune)\b/.test(text);
  const discussion = /\b(how|detect|detecting|detection|debunk|ethics|explained|lecture|conference|analysis|analyse|detecter)\b/.test(title);
  if (!negated(title) && !discussion && (/[\[(]\s*ai[- ]generated\s*[\])]/.test(title)
    || /\b(?:fully|entirely|100%) ai[- ]generated\b/.test(title)
    || /\bai[- ]generated (?:documentary|film|animation|video)\b/.test(title))) return ['Declared AI-generated production'];
  const clauses = normalize(video.description).split(/[.!?\n]+/);
  for (const clause of clauses) {
    if (negated(clause)) continue;
    if (/\b(?:this|our) (?:video|film|documentary|animation|narration|voice ?over|audio|visuals?) (?:is|was|has been|were|are) (?:(?:entirely|fully|100%|partly|partially) )?(?:ai[- ]generated|(?:generated|created|produced|narrated|voiced) (?:with|using|by) (?:generative )?(?:ai|artificial intelligence))\b/.test(clause)
      || /\b(?:this|our) (?:video|film|documentary) uses (?:an? )?(?:ai[- ]generated|synthetic) (?:voice|narration|visuals|animation)\b/.test(clause)
      || /^\s*(?:narration|voice ?over|visuals|animation)\s*:\s*(?:ai[- ]generated|synthetic)\b/.test(clause)
      || /\b(?:cette|notre) (?:video|animation|narration)|\b(?:ce|notre) (?:film|documentaire)/.test(clause)
        && /\b(?:est|a ete) (?:entierement )?(?:genere[es]*|cree[es]*|produit[es]*) (?:par|avec) (?:une? |l['’])?(?:ia|intelligence artificielle)\b/.test(clause)) return ['Declared synthetic production'];
  }
  return [];
}
function durationBounds(state) {
  if (state.minMinutes !== undefined || state.maxMinutes !== undefined) {
    const min = state.minMinutes, max = state.maxMinutes;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 360 || min > max) throw new Error('INVALID_FILTER');
    return [min * 60, max * 60 + 1];
  }
  const bounds = { all: [1200, 7201], medium: [1200, 2400], long: [2400, 3600], deep: [3600, 7201] }[state.duration];
  if (!bounds) throw new Error('INVALID_FILTER');
  return bounds;
}
export function visibleRows(snapshot, state) {
  const search = state.search.trim().toLocaleLowerCase('en');
  const bounds = durationBounds(state);
  if (!bounds || !['diversified', 'search_baseline'].includes(state.method)) throw new Error('INVALID_FILTER');
  return Object.fromEntries(STREAMS.map(s => {
    const rows = snapshot.rankings[state.method][s].filter(v =>
    !state.hidden.has(v.video_id) && !isChannelBlocked(v, state.blockedChannels ?? []) && (!state.savedOnly || state.saved.has(v.video_id))
    && v.duration_seconds >= bounds[0] && v.duration_seconds < bounds[1]
    && (!search || `${v.title} ${v.channel}`.toLocaleLowerCase('en').includes(search)));
    if (state.preferInstitutions && state.method === 'diversified') {
      rows.sort((a, b) => institutionalSignals(b).length - institutionalSignals(a).length);
    }
    return [s, rows];
  }));
}
export function escapeEmbeddedJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function searchWords(text) {
  return (text.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? []).map(word =>
    /^(math|maths|mathematical|mathematics)$/.test(word) ? 'mathematics'
    : /^(history|historical|histories)$/.test(word) ? 'history'
    : /^(proof|proofs)$/.test(word) ? 'proof' : word);
}
export function queryTerms(query) {
  if (typeof query !== 'string' || query.length > 300) throw new Error('INVALID_QUERY');
  const stop = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'on', 'in', 'to', 'for', 'about', 'with', 'i', 'want', 'watch', 'some', 'videos', 'video', 'please', 'me', 'show']);
  return [...new Set(searchWords(query).filter(word => word.length > 1 && !stop.has(word)))].slice(0, 30);
}
export function searchCatalog(catalog, query, state) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const bounds = durationBounds(state);
  if (!bounds) throw new Error('INVALID_FILTER');
  const filter = state.search.trim().toLocaleLowerCase('en');
  const matches = [];
  for (const v of catalog) {
    if (state.hidden.has(v.video_id) || (state.savedOnly && !state.saved.has(v.video_id))
        || v.duration_seconds < bounds[0] || v.duration_seconds >= bounds[1]
        || (filter && !`${v.title} ${v.channel}`.toLocaleLowerCase('en').includes(filter))) continue;
    const title = new Set(searchWords(v.title)), channel = new Set(searchWords(v.channel));
    const description = new Set(searchWords(v.description ?? ''));
    if (!terms.every(term => title.has(term) || channel.has(term) || description.has(term))) continue;
    const score = terms.reduce((n, term) => n + (title.has(term) ? 6 : channel.has(term) ? 3 : 1), 0)
      + (state.preferInstitutions ? 2 * institutionalSignals(v).length : 0);
    matches.push({ ...v, match_terms: terms, local_search_score: score });
  }
  return matches.sort((a, b) => b.local_search_score - a.local_search_score || a.video_id.localeCompare(b.video_id));
}
export function filterLiveResults(videos, state) {
  const bounds = durationBounds(state);
  if (!bounds) throw new Error('INVALID_FILTER');
  const text = state.search.trim().toLocaleLowerCase('en');
  const rows = videos.filter(v => !syntheticProductionSignals(v).length && !state.hidden.has(v.video_id) && !isChannelBlocked(v, state.blockedChannels ?? []) && (!state.savedOnly || state.saved.has(v.video_id))
    && ((['youtube_web', 'external_web'].includes(v.source) && v.duration_seconds === null) || (v.duration_seconds >= bounds[0] && v.duration_seconds < bounds[1]))
    && (!text || `${v.title} ${v.channel}`.toLocaleLowerCase('en').includes(text)));
  const preferences = state.liveResult?.preferences;
  if (preferences) {
    const extent = values => [Math.min(...values), Math.max(...values)];
    const dates = extent(rows.map(v => Date.parse(v.published_at)).filter(Number.isFinite));
    const views = extent(rows.filter(v => Number.isFinite(v.views) && v.views >= 0).map(v => Math.log1p(v.views)));
    const normalized = (value, [low, high]) => Number.isFinite(value) && high > low ? (value - low) / (high - low) - 0.5 : 0;
    const strength = axis => ((preferences[axis] ?? 50) - 50) / 50;
    const score = v => (51 - Math.min(50, v.provider_rank ?? 50)) / 50
      + strength('origin') * Math.min(3, institutionalSignals(v).length) / 3
      + 2 * strength('recency') * normalized(Date.parse(v.published_at), dates)
      + 2 * strength('popularity') * normalized(Number.isFinite(v.views) && v.views >= 0 ? Math.log1p(v.views) : NaN, views);
    rows.sort((a, b) => score(b) - score(a) || a.provider_rank - b.provider_rank);
  }
  else if (state.preferInstitutions) rows.sort((a, b) => institutionalSignals(b).length - institutionalSignals(a).length || a.provider_rank - b.provider_rank);
  return rows;
}

// Input is already filtered and ranked. Preserve that ordering WITHIN each
// angle, then alternate angles so source boosts cannot erase topic diversity.
export function selectDiscoveryRows(videos, stream, limit = 12) {
  const groups = new Map();
  for (const video of videos) {
    if (video.discovery_stream !== stream) continue;
    const key = video.discovery_query ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }
  const selected = [], channels = new Map(), titles = new Set(), ids = new Set();
  const normalize = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const perAngleLimit = stream === 'direct' ? limit : 4;
  const lanes = [...groups.values()].map(rows => ({ rows, cursor: 0, count: 0 }));
  let added;
  do {
    added = false;
    for (const lane of lanes) {
      if (lane.count >= perAngleLimit || selected.length >= limit) continue;
      while (lane.cursor < lane.rows.length) {
        const video = lane.rows[lane.cursor++], channel = video.channel_id ?? normalize(video.channel), title = normalize(video.title);
        if (ids.has(video.video_id) || (title && titles.has(title)) || (channel && (channels.get(channel) ?? 0) >= 2)) continue;
        selected.push(video); ids.add(video.video_id); if (title) titles.add(title);
        if (channel) channels.set(channel, (channels.get(channel) ?? 0) + 1);
        lane.count++; added = true; break;
      }
    }
  } while (added && selected.length < limit);
  return selected;
}

function alternateAngles(videos) {
  const groups = new Map();
  for (const video of videos) {
    const key = video.discovery_query ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }
  const rows = [];
  for (let i = 0; [...groups.values()].some(g => i < g.length); i++) for (const g of groups.values()) if (g[i]) rows.push(g[i]);
  return rows;
}

// Two live columns: the subject, then a mix of nearby and distant connections.
export function selectSearchColumns(videos, threeColumns = false, limit = 8) {
  limit = Number.isSafeInteger(limit) ? Math.max(8, Math.min(50, limit)) : 8;
  const rows = { direct: [], related: [], ...(threeColumns ? { wildcard: [] } : {}) }, seen = new Set();
  const usage = Object.fromEntries(Object.keys(rows).map(column => [column, { channels: new Map(), angles: new Map(), titles: new Set(), platforms: new Map() }]));
  const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const candidates = threeColumns ? STREAMS.flatMap(stream => stream === 'wildcard' ? prioritizeExternal(alternateAngles(videos.filter(video => video.discovery_stream === stream))) : stream === 'adjacent' ? alternateAngles(videos.filter(video => video.discovery_stream === stream)) : videos.filter(video => video.discovery_stream === stream)) : videos;
  // Reserve the first page in every column before allocating overflow. Scrolling
  // must not move a card from RELATED into DIRECT merely because its pool overlaps.
  for (let page = 8; page < limit + 8; page += 8) for (const video of candidates) {
    if (!STREAMS.includes(video.discovery_stream) || seen.has(video.video_id)) continue;
    const column = threeColumns && video.discovery_stream === 'wildcard' ? 'wildcard' : video.discovery_stream === 'direct' ? 'direct' : 'related', count = usage[column];
    const channel = video.channel_unknown ? '' : video.channel_id ?? normalize(video.channel), title = normalize(video.title), angle = video.discovery_query ?? video.discovery_why ?? '';
    const platform = video.platform ?? 'YouTube';
    if (rows[column].length >= Math.min(page, limit) || title && count.titles.has(title) || channel && (count.channels.get(channel) ?? 0) >= 2
      || column === 'wildcard' && (count.platforms.get(platform) ?? 0) >= (platform === 'YouTube' ? limit : 3)
      || column === 'related' && (count.angles.get(angle) ?? 0) >= (video.source === 'youtube_live' ? limit : 4)) continue;
    rows[column].push(video); seen.add(video.video_id); if (title) count.titles.add(title);
    if (channel) count.channels.set(channel, (count.channels.get(channel) ?? 0) + 1);
    count.angles.set(angle, (count.angles.get(angle) ?? 0) + 1);
    count.platforms.set(platform, (count.platforms.get(platform) ?? 0) + 1);
  }
  return rows;
}

// Arrivals keep their places; retained cards are placeholders, never new hits.
export function replacementColumn(fresh, previous, allFreshIds, limit = 15) {
  const head = fresh.slice(0, limit).map(video => ({ video, previous: false }));
  const seen = new Set(allFreshIds);
  const tail = previous.slice(head.length, limit).filter(video => {
    if (seen.has(video.video_id)) return false;
    seen.add(video.video_id); return true;
  }).map(video => ({ video, previous: true }));
  return [...head, ...tail];
}
