import { ARCHIVE_CLEAR_KEY, createSearchArchive, archiveRecommendations } from './search-archive.mjs';
import { createQueryInterpretation } from './query-interpretation.mjs';
import { createElementFactory } from './dom.mjs';
import { createRequestOwner } from './request-owner.mjs';
import SNAPSHOT from 'mytube:snapshot';
import { defaultPreferences, validatePreferences } from '../extension/preferences.mjs';
import { VIEWING_PREFERENCES_KEY, saveViewingPreferences, loadViewingPreferences } from './preference-store.mjs';
import { isChannelBlocked, blockChannel, loadChannelBlocks, saveChannelBlocks } from './channel-blocks.mjs';
import { STREAMS, uniqueVideos, detectLiveStatus, visibleRows, searchCatalog, filterLiveResults, selectDiscoveryRows, replacementColumn } from './model.mjs';
import { HOME_KEY, emptyHome, cleanHome, loadHome, saveHome, rememberHome, homeTopics, mergeHomeRefresh, homePicks, cachedSearchPicks, pastSearchPicks } from './home.mjs';
import { LAST_SEARCH_KEY, clearLastSearch, loadLastSearch, saveLastSearch } from './last-search-store.mjs';
import { createSearchLifecycle } from './search-lifecycle.mjs';
import { projectOrderedVideos, projectSearchColumns } from './search-columns.mjs';
import { renderVideoCard } from './video-card.mjs';
import { createVideoDurations } from './video-durations.mjs';
import { bindPreferenceControls } from './preference-controls.mjs';
import { createQueryDialog } from './query-dialog.mjs';
import { renderSearchDetails } from './search-details.mjs';
import { bindHistoryControls } from './history-controls.mjs';
import { renderBlockedChannels } from './channel-controls.mjs';
import { bindTheme } from './theme.mjs';

bindTheme();
const setupAccessLink = document.getElementById('setup-access-link');
if (setupAccessLink) setupAccessLink.hidden = !['chrome-extension:', 'moz-extension:'].includes(globalThis.location?.protocol);

let viewingPreferences = defaultPreferences();
const $ = id => document.getElementById(id);
const element = createElementFactory(document);
const state = { query: null, source: 'local', liveQuery: null, liveResult: null, liveError: null, loading: false, stage: 'planning',
  search: '', duration: 'all', minMinutes: 20, maxMinutes: 120, method: 'diversified', preferInstitutions: true, savedOnly: false, saved: new Set(), hidden: new Set() };
const searchLifecycle = createSearchLifecycle({ state, changed: () => { persistLastPage(); render(); },
  errorCode: error => Object.hasOwn(liveMessages, error?.code) ? error.code : 'REQUEST_FAILED' });
let previousSearchRows = {}, lastSearchRows = {}, arrivalOrder = {}, renderCardCache = new Map();
let recentVideos = [], lastFreshVideos = [], liveArrivalOrder = {};
let visibleResultLimit = 8, resultObserver = null;
function rowsByColumn(videos) {
  const rows = Object.fromEntries(STREAMS.map(stream => [stream, []]));
  for (const [index, video] of videos.entries()) {
    const stream = STREAMS.includes(video.discovery_stream) ? video.discovery_stream : STREAMS[index % 3];
    if (rows[stream].length < 15) rows[stream].push(video);
  }
  return rows;
}
let homeStorage;
try { if (['chrome-extension:', 'moz-extension:'].includes(globalThis.location?.protocol)) homeStorage = globalThis.localStorage; } catch { /* Unavailable storage: session-only. */ }
let home = loadHome(homeStorage), homeMode = Boolean(homeStorage) || globalThis.MyTubeLive?.status?.().provider === 'chatgpt_web', homeEpoch = 0;
const homeRefresh = createRequestOwner();
viewingPreferences = loadViewingPreferences(homeStorage, [...home.topics].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.preferences);
state.minMinutes = viewingPreferences.minMinutes; state.maxMinutes = viewingPreferences.maxMinutes;
function persistViewingPreferences() { saveViewingPreferences(homeStorage, viewingPreferences); }
let blockedChannels = loadChannelBlocks(homeStorage);
state.blockedChannels = blockedChannels;
const channelAllowed = video => !isChannelBlocked(video, blockedChannels);
let homeNotice = '';
let archiveRows = [], currentArchive = null;
let subscriptionsMode = false, subscriptionVideos = [], subscriptionNext = null, subscriptionLoaded = false;
let subscriptionNotice = '', subscriptionChannels = 0, subscriptionSort = 'recent';
const subscriptionRequest = createRequestOwner();
const archive = createSearchArchive({ storage: homeStorage, onError() {
  homeNotice = 'History could not be saved. Device storage may be full or unavailable.';
  $('history-storage-warning').hidden = false;
} });
function archiveResult(result) {
  if (!home.enabled || !currentArchive || currentArchive.epoch !== homeEpoch || result?.provisional_source === 'cache') return;
  const previous = archiveRows.find(r => r.id === currentArchive.id);
  const videos = uniqueVideos([...(result?.videos ?? []).map(v => ({ ...withKnownDuration(v), cachedAt: Date.now() })), ...(previous?.videos ?? [])]);
  const row = { ...currentArchive, videos, count: videos.length };
  archiveRows = [row, ...archiveRows.filter(r => r.id !== row.id)];
  void archive.put(row);
}

recentVideos = pastSearchPicks(home);
const videoDurations = createVideoDurations({ videos: home.topics.flatMap(topic => topic.videos),
  load: ids => globalThis.MyTubeLive.loadVideoDurations(ids), generation: () => homeEpoch });
const externalPreviews = new Map(), previewAttempts = new Set(), previewQueue = [];
let previewWorkers = 0;
const withKnownDuration = video => videoDurations.apply({ ...video, ...externalPreviews.get(video.video_id) });
function scheduleExternalPreview(video) {
  if (video.source !== 'external_web' || !globalThis.MyTubeLive?.loadExternalPreview
    || video.thumbnail_url && video.duration_seconds || previewAttempts.has(video.video_id) || previewAttempts.size >= 200) return;
  previewAttempts.add(video.video_id); previewQueue.push({ video, epoch: homeEpoch });
  const drain = () => {
    while (previewWorkers < 4 && previewQueue.length) {
      const { video, epoch } = previewQueue.shift();
      if (epoch !== homeEpoch) continue;
      previewWorkers++;
      Promise.resolve().then(() => globalThis.MyTubeLive.loadExternalPreview(video)).then(metadata => {
        if (epoch !== homeEpoch || !metadata || !Object.keys(metadata).length) return;
        externalPreviews.set(video.video_id, metadata);
        for (const topic of home.topics) topic.videos = topic.videos.map(withKnownDuration);
        persistHome(); render();
        if ($('past-searches-dialog').hasAttribute('open')) renderPastSearches();
      }).catch(() => {}).finally(() => { previewWorkers--; drain(); });
    }
  };
  drain();
}
let durationTimer = null;
function scheduleVideoDurations() {
  if (durationTimer !== null || !globalThis.MyTubeLive?.loadVideoDurations) return;
  durationTimer = setTimeout(async () => {
    durationTimer = null;
    const ids = [...document.querySelectorAll('.video-card')]
      .filter(tile => !tile.querySelector('.duration-badge'))
      .map(tile => tile.getAttribute('data-video-id'));
    if (!await videoDurations.enrich(ids)) return;
    for (const topic of home.topics) topic.videos = topic.videos.map(withKnownDuration);
    if (home.enabled) persistHome();
    render(); if ($('past-searches-dialog').hasAttribute('open')) renderPastSearches();
  }, 500);
}
state.saved = new Set(home.saved); state.hidden = new Set(home.hidden);
let lastPageWritable = true;
const restoredPage = loadLastSearch(homeStorage, home.enabled);
if (restoredPage) {
  state.query = restoredPage.query; state.liveQuery = restoredPage.query; state.source = 'live';
  state.liveResult = { provider: restoredPage.provider, query: restoredPage.query, videos: restoredPage.videos,
    preferences: restoredPage.preferences, restored: true, interrupted: restoredPage.interrupted };
  visibleResultLimit = restoredPage.limit; liveArrivalOrder = restoredPage.order;
}
function persistLastPage() {
  if (!lastPageWritable || state.source !== 'live' || !state.query || !state.liveResult?.videos?.length
    || state.liveResult.provisional_source === 'cache') return;
  saveLastSearch(homeStorage, { query: state.query, videos: state.liveResult.videos.map(withKnownDuration),
    preferences: state.liveResult.preferences ?? viewingPreferences, provider: state.liveResult.provider,
    interrupted: state.loading || state.liveResult.interrupted === true,
    order: liveArrivalOrder, limit: visibleResultLimit }, home.enabled);
}
function persistArchiveMetadata() {
  if (!home.enabled) return;
  archiveRows = archiveRows.map(row => {
    const videos = row.videos.map(withKnownDuration);
    if (JSON.stringify(videos) !== JSON.stringify(row.videos)) { const updated = { ...row, videos }; void archive.put(updated); return updated; }
    return row;
  });
}
function persistHome() {
  persistArchiveMetadata();
  if (home.enabled) { home.saved = [...state.saved].slice(-300); home.hidden = [...state.hidden].slice(-300); }
  home = cleanHome(home); saveHome(homeStorage, home);
}
function renderPastSearches() {
  const previousCache = renderCardCache; renderCardCache = new Map();
  const container = $('past-searches-videos'); container.replaceChildren();
  for (const [recordIndex, record] of archiveRows.entries()) {
    const row = element('details', 'archived-search');
    row.append(element('summary', '', `${new Date(record.at).toLocaleDateString()} ? ${record.query} (${record.count} found)`));
    const again = element('button', 'outline-button', 'Search again');
    again.addEventListener('click', () => { $('past-searches-dialog').close(); openQuery(record.query, true); }); row.append(again);
    const forget = element('button', 'text-button', 'Forget this search');
    forget.addEventListener('click', () => {
      if (currentArchive?.id === record.id) currentArchive = null;
      if (state.query === record.query) { lastPageWritable = false; clearLastSearch(homeStorage); }
      archiveRows = archiveRows.filter(r => r.id !== record.id); void archive.remove(record.id);
      const ids = new Set(record.videos.map(v => v.video_id));
      home.topics = home.topics.filter(t => !t.videos.some(v => ids.has(v.video_id)));
      persistHome(); recentVideos = pastSearchPicks(home); renderPastSearches(); if (homeMode) render();
    }); row.append(forget);
    const grid = element('div', 'home-grid');
    let populated = false;
    const populate = () => {
      if (populated) return; populated = true;
      for (const video of record.videos.filter(v => channelAllowed(v) && !state.hidden.has(v.video_id))) grid.append(card(video));
      scheduleVideoDurations();
    };
    if (recordIndex < 2) { row.setAttribute('open', ''); populate(); }
    row.addEventListener('toggle', () => { if (row.hasAttribute('open')) populate(); });
    row.append(grid);
    if (!record.videos.length) row.append(element('p', 'settings-note', 'No cached videos. Search again to refresh results.'));
    container.append(row);
  }
  if (archiveRows.length) { renderCardCache = previousCache; scheduleVideoDurations(); return; }
  const videos = uniqueVideos([...recentVideos, ...pastSearchPicks(home)])
    .filter(v => channelAllowed(v) && !state.hidden.has(v.video_id));
  for (const video of videos) container.append(card(withKnownDuration(video)));
  if (!videos.length) container.append(element('p', 'empty', 'Your past discoveries will appear here.'));
  renderCardCache = previousCache; scheduleVideoDurations();
}
function syncBlockedChannels() {
  renderBlockedChannels(document, blockedChannels, unblockChannel);
  if ($('past-searches-dialog').hasAttribute('open')) renderPastSearches();
}
function unblockChannel(record) {
  blockedChannels = blockedChannels.filter(row => row !== record); state.blockedChannels = blockedChannels;
  saveChannelBlocks(homeStorage, blockedChannels); syncBlockedChannels(); render();
}
function syncHomeSettings() {
  $('refresh-home').hidden = !globalThis.MyTubeLive?.refreshHome;
  $('remember-interests').checked = home.enabled;
  $('home-status').textContent = homeNotice;
  const interests = $('home-interests'); interests.replaceChildren();
  for (const topic of homeTopics(home)) {
    const button = element('button', 'subtle-button', `${topic.label} ×`);
    button.title = `Remove cached topic ${topic.label}; full requests remain in Past searches`;
    button.addEventListener('click', () => { homeRefresh.cancel(); home.topics = home.topics.filter(t => t !== topic); persistHome(); recentVideos = pastSearchPicks(home); syncHomeSettings(); if (homeMode) render(); });
    interests.append(button);
  }
}
async function refreshPersonalHome(force = false) {
  if (!home.enabled || !home.topics.length || !globalThis.MyTubeLive?.refreshHome || homeRefresh.active || searchLifecycle.active
    || (!force && (!homeMode || document.visibilityState === 'hidden' || Date.now() - home.refreshedAt < 6 * 3600000))) return;
  const request = homeRefresh.start();
  home.refreshedAt = Date.now(); persistHome(); homeNotice = 'Updating suggestions…'; syncHomeSettings();
  if (homeMode) render();
  const topics = homeTopics(home).sort((a, b) => a.refreshedAt - b.refreshedAt).slice(0, 2);
  try {
    await globalThis.MyTubeLive.refreshHome(topics, request.signal, batch => {
      if (!request.isCurrent()) return;
      const topic = home.topics.find(t => t.label === batch.label); if (!topic) return;
      topic.refreshedAt = Date.now();
      topic.videos = mergeHomeRefresh(topic.videos, batch.videos, state.saved);
      persistHome(); if (homeMode) render();
    });
    if (request.isCurrent()) homeNotice = 'Suggestions updated.';
  } catch { if (request.isCurrent()) homeNotice = 'Showing cached suggestions. A live search can reconnect YouTube.'; }
  finally { if (request.finish()) { syncHomeSettings(); if (homeMode) render(); } }
}
function renderHome(container) {
  let videos;
  if (state.savedOnly) videos = uniqueVideos([...archiveRows.flatMap(r => r.videos), ...homePicks(home).saved, ...(state.liveResult?.videos ?? []), ...recentVideos])
    .filter(v => state.saved.has(v.video_id));
  else if (subscriptionsMode) videos = [...subscriptionVideos].sort((a, b) => subscriptionSort === 'popular'
    ? (b.views ?? 0) - (a.views ?? 0) : Date.parse(b.published_at) - Date.parse(a.published_at));
  else videos = uniqueVideos([...archiveRecommendations(archiveRows, { hidden: state.hidden, saved: state.saved, allowed: channelAllowed }), ...homePicks(home).recent, ...homePicks(home).lasting]);
  videos = videos.filter(v => !state.hidden.has(v.video_id) && channelAllowed(v));
  container.classList.add('home-results'); container.classList.remove('catalog-results');
  container.setAttribute('aria-busy', String(subscriptionsMode && subscriptionRequest.active));
  $('current-topic').textContent = state.savedOnly ? 'Saved videos' : subscriptionsMode ? "What's up in your subscriptions" : 'For you';
  $('current-topic').title = '';
  document.querySelector('.collection-heading').hidden = true;
  $('collection-note').hidden = true;
  $('review-request').hidden = !state.query; $('ai-button').hidden = true; $('method-switch').hidden = true;
  $('interpreted-request').hidden = true;
  if (subscriptionsMode && !state.savedOnly) {
    const controls = element('div', 'feed-controls');
    for (const [value, label] of [['recent', 'Latest'], ['popular', 'Most viewed']]) {
      const button = element('button', 'outline-button', label);
      button.setAttribute('aria-pressed', String(subscriptionSort === value));
      button.addEventListener('click', () => { subscriptionSort = value; render(); }); controls.append(button);
    }
    const refresh = element('button', 'primary-button', subscriptionLoaded ? 'Refresh subscriptions' : 'Connect YouTube');
    refresh.disabled = subscriptionRequest.active;
    refresh.addEventListener('click', () => loadSubscriptions(false)); controls.append(refresh);
    if (subscriptionRequest.active) {
      const stop = element('button', 'outline-button', 'Stop');
      stop.addEventListener('click', () => { subscriptionRequest.cancel(); subscriptionNotice = 'Stopped. Received videos remain available.'; render(); }); controls.append(stop);
    }
    container.append(controls);
    const note = element('p', 'settings-note', subscriptionNotice || 'Connect your YouTube account to read subscriptions. Latest five uploads per channel, filtered by your video settings.');
    note.setAttribute('role', 'status'); container.append(note);
  } else if (!state.savedOnly) container.append(element('p', 'settings-note', 'Rediscover videos from your searches. Your interests and history stay on this device.'));
  const grid = element('div', 'home-grid');
  for (const video of videos) { const tile = card(video); markPrevious(tile, false); grid.append(tile); }
  container.append(videos.length ? grid : element('div', 'empty', state.savedOnly ? 'No saved videos yet.' : subscriptionsMode ? 'Videos from your subscriptions will appear here.' : 'Start a search to build your recommendations.'));
  if (subscriptionsMode && subscriptionNext && !state.savedOnly) {
    const more = element('button', 'outline-button', 'Load more subscriptions'); more.disabled = subscriptionRequest.active;
    more.addEventListener('click', () => loadSubscriptions(true)); container.append(more);
  }
  $('status').textContent = `${videos.length} videos.`;
}
async function loadSubscriptions(more) {
  if (subscriptionRequest.active) return;
  const request = subscriptionRequest.start();
  subscriptionNotice = 'Connecting to YouTube and loading subscriptions...'; render();
  if (!more) { subscriptionVideos = []; subscriptionNext = null; subscriptionChannels = 0; }
  try {
    const result = await globalThis.MyTubeLive.subscriptions({ signal: request.signal, pageToken: more ? subscriptionNext : undefined,
      preferences: viewingPreferences, onBatch(videos) {
        if (!request.isCurrent()) return;
        subscriptionVideos = uniqueVideos([...subscriptionVideos, ...videos]);
        subscriptionNotice = `${subscriptionVideos.length} videos received. Loading more...`; if (subscriptionsMode) render();
      } });
    if (!request.isCurrent()) return;
    subscriptionLoaded = true; subscriptionNext = result.nextPageToken; subscriptionChannels += result.channels;
    subscriptionNotice = `${subscriptionChannels} subscriptions checked. Latest five uploads per channel; Most viewed ranks this selection.${result.failed ? ` ${result.failed} channels could not load.` : ''}${subscriptionNext ? ' More subscriptions are available below.' : ''}`;
  } catch (error) { if (request.isCurrent()) subscriptionNotice = liveMessages[error?.code] ?? 'Subscriptions are unavailable. Configure Google sign-in for this extension.'; }
  finally { if (request.finish() && subscriptionsMode) render(); }
}
let loadingStartedAt = 0;
let loadingTimer = null;
function updateLoadingTime() {
  const timer = $('loading-time');
  if (!timer) return;
  const seconds = Math.max(0, Math.floor((Date.now() - loadingStartedAt) / 1000));
  timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`;
}
let intentionDraft = '';
let liveStatus = detectLiveStatus(globalThis.MyTubeLive, globalThis.browser ?? globalThis.chrome, globalThis.location?.protocol);
const liveMessages = {
  YOUTUBE_KEY_MISSING: 'Add your YouTube key to the local .secrets file, then start a new search.',
  YOUTUBE_KEY_INVALID: 'The local YouTube key configuration is invalid. Check .secrets in your own editor; do not paste the key into chat.',
  WEB_SEARCH_NO_SOURCED_VIDEOS: 'No verified video links were found. Your request has been kept.',
  WEB_SEARCH_LIMIT_REACHED: 'The web search reached its limit. Your request has been kept.',
  CONNECTOR_UNAVAILABLE: 'Start the local MyTube connector with npm.cmd run connector, then try again.',
  CONNECTOR_ACCESS_DENIED: 'The connector is running but rejected this extension connection. Reload MyTube and restart the updated connector.',
  CONNECTOR_UPDATE_REQUIRED: 'The connector and extension versions do not match. Restart the updated connector, then reload MyTube.',
  CONNECTOR_PROTOCOL_ERROR: 'The connector returned an unexpected response. Restart it and try again.',
  CONNECTOR_BUSY: 'The connector is finishing another request. Wait for it to finish before searching again.',
  SIGN_IN_WINDOW_FAILED: 'The sign-in window could not open. Cancel this search and try again.',
  INVALID_INTENTION: 'This description is too large. Please shorten it before trying again.',
  INVALID_SEARCH_PLAN: 'ChatGPT did not return a usable search plan. No further search was sent.',
  INVALID_PLAN_SUBJECTS: 'Automatic correction could not identify usable subject names. Your original request is preserved.',
  OFF_TOPIC_SEARCH_PLAN: 'ChatGPT’s searches drifted from the identified subject. Try again.',
  REPEATED_SEARCH_QUERIES: 'ChatGPT repeated searches instead of providing different angles. Try again.',
  CHATGPT_FAILED: 'ChatGPT could not complete this request. Try again.',
  CHATGPT_SIGN_IN_REQUIRED: 'ChatGPT rejected the new connection. Check your account and MyTube access before trying again.',
  CHATGPT_ACCESS_DENIED: 'ChatGPT access is unavailable for this account or integration.',
  CHATGPT_LIMIT_REACHED: 'A ChatGPT usage or rate limit was reached. Check your plan usage before trying again.',
  CHATGPT_UNAVAILABLE: 'ChatGPT is temporarily unavailable. Your connection has been kept; try again later.',
  CHATGPT_REQUEST_REJECTED: 'ChatGPT rejected the search request. The integration needs checking.',
  CHATGPT_RESPONSE_INCOMPLETE: 'ChatGPT returned an incomplete response. Try the search again.',
  CHATGPT_REFUSED: 'ChatGPT declined this request. You can edit your request and try again.',
  CHATGPT_TIMEOUT: 'The ChatGPT request timed out.',
  CLEANUP_REQUIRED: 'OpenAI session cleanup was not confirmed. Disconnect MyTube in your ChatGPT account before trying again.',
  EXTENSION_REQUIRED: 'This is the file preview. Open the installed MyTube extension from your browser’s Extensions menu to connect.',
  LIVE_MODULE_UNAVAILABLE: 'The live-search module did not load. Reload MyTube on the browser extensions page, close this tab, then reopen MyTube from its toolbar icon.',
  RELOAD_REQUIRED: 'This tab belongs to an older extension session. Close it and reopen MyTube from its toolbar icon.',
  GOOGLE_SETUP_REQUIRED: 'Live search needs the developer Google registration before it can connect.',
  BROWSER_AUTH_UNSUPPORTED: 'Optional Google subscriptions are unavailable in this browser. Normal discovery uses the local companion and ChatGPT sign-in.',
  GOOGLE_SIGN_IN_FAILED: 'Google sign-in was cancelled or could not complete. Brave may reject this authentication flow. No search results were retrieved.',
  REQUIRED_SCOPE_MISSING: 'The required YouTube read-only permission was not confirmed. No search was sent.',
  SIGN_IN_REQUIRED: 'Google authorization expired or was rejected. Start a new search to sign in again.',
  ACCESS_OR_QUOTA_DENIED: 'Google denied API access or the project quota is exhausted. No automatic retry was made.',
  RATE_LIMITED: 'YouTube’s API is limiting searches. Fresh results are unavailable for now.',
  QUOTA_EXCEEDED: 'YouTube’s API search quota is exhausted. Fresh results are unavailable for now.',
  CANCELLED: 'Live search cancelled.', TIMEOUT: 'The YouTube request timed out.',
  PROVIDER_UNAVAILABLE: 'YouTube is temporarily unavailable.', INVALID_RESPONSE: 'YouTube returned an unexpected response.',
  RESPONSE_TOO_LARGE: 'The YouTube response exceeded this preview’s size limit.', REQUEST_FAILED: 'The YouTube request could not complete.',
};
const copy = {
  direct: ['A', 'DIRECT'],
  adjacent: ['B', 'ADJACENT'],
  wildcard: ['C', 'WILDCARD'],
};

function card(v) {
  v = withKnownDuration(v); scheduleExternalPreview(v);
  const renderKey = JSON.stringify([v, videoDurations.get(v.video_id), state.saved.has(v.video_id), home.enabled]);
  const existing = renderCardCache.get(v.video_id);
  if (existing?.getAttribute('data-render-key') === renderKey) { renderCardCache.delete(v.video_id); return existing; }
  const article = renderVideoCard(document, v, {
    saved: state.saved.has(v.video_id), persistent: Boolean(homeStorage && home.enabled),
    thumbnail: SNAPSHOT.images[v.video_id], knownDuration: videoDurations.get(v.video_id),
    onSave: toggleSavedVideo, onHide: hideVideo, onBan: banVideoChannel,
  });
  article.setAttribute('data-render-key', renderKey);
  return article;
}
function toggleSavedVideo(v) {
  state.saved.has(v.video_id) ? state.saved.delete(v.video_id) : state.saved.add(v.video_id);
  persistHome();
  if (state.savedOnly) render(); else updateTabs();
  const saved = state.saved.has(v.video_id);
  $('status').textContent = saved ? (homeStorage && home.enabled ? 'Saved on this device.' : 'Saved for this session.') : 'Removed from saved picks.';
  return saved;
}
function hideVideo(v) {
  state.hidden.add(v.video_id); persistHome(); render();
  if ($('past-searches-dialog').hasAttribute('open')) renderPastSearches(); else $('settings-button').focus();
}
function banVideoChannel(v) {
  blockedChannels = blockChannel(blockedChannels, v); state.blockedChannels = blockedChannels;
  const saved = saveChannelBlocks(homeStorage, blockedChannels);
  render(); syncBlockedChannels();
  $('status').textContent = saved ? `${v.channel} hidden. Undo in Blocked channels.` : `${v.channel} hidden for this session; local storage is unavailable.`;
}
function updateTabs() {
  $('saved-count').textContent = state.saved.size;
  for (const [id, active] of [['saved-tab', state.savedOnly]]) {
    $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', String(active));
  }
}
function markPrevious(tile, previous) {
  tile.classList.toggle('previous-result', previous);
  tile.classList.toggle('pending-replacement', previous && state.loading);
  tile.style.setProperty('--search-phase', `${-((Date.now() - loadingStartedAt) % 4800)}ms`);
  const label = tile.querySelector('.previous-result-label');
  if (previous && !label) tile.append(element('span', 'previous-result-label', 'Previous search'));
  else if (!previous) label?.remove();
}
function cancelLiveSearch() {
  queryInterpretation.cancel();
  searchLifecycle.cancel('CANCELLED'); render();
}
function renderWebSearch(container) {
  const idle = state.query === null;
  $('current-topic').hidden = idle;
  $('current-topic').textContent = idle ? '' : state.query.length > 100 ? state.query.slice(0, 100) + '…' : state.query;
  $('current-topic').title = state.query ?? '';
  $('current-topic').setAttribute('aria-busy', String(state.loading));
  $('search-invitation').hidden = !idle;
  document.querySelector('.collection-heading').hidden = idle;
  $('collection-note').hidden = true;
  $('collection-note').textContent = state.liveResult?.provider === 'youtube_api' ? 'YouTube API · Duration metadata checked; language checked when available' : 'ChatGPT web search · Length and language preferences are not verified';
  $('review-request').hidden = idle; $('ai-button').hidden = true; $('method-switch').hidden = true;
  container.setAttribute('aria-busy', String(state.loading));
  if ($('request-dialog').open || $('request-dialog').hasAttribute('open')) renderRequest();
  const candidates = state.liveResult?.provisional_source === 'cache' ? [] : filterLiveResults((state.liveResult?.videos ?? []).map(withKnownDuration).filter(channelAllowed), state);
  const { rows, selected, count, order } = projectSearchColumns(candidates, liveArrivalOrder, visibleResultLimit);
  liveArrivalOrder = order;
  if (count) lastFreshVideos = rows.direct.flatMap((v, i) => [v, rows.related[i]].filter(Boolean)).concat(rows.related.slice(rows.direct.length), rows.wildcard);
  $('current-topic').classList.toggle('query-loading', state.loading && count < 12);
  container.classList.remove('catalog-results'); container.classList.add('two-column-search');
  $('result-count').hidden = false; $('result-count').textContent = visibleResultLimit === 8 ? `${count} / 24` : `${count} videos`;
  $('collection-title').firstChild.textContent = 'Discoveries ';
  if (state.loading && count < 12 || state.liveError) {
    const feedback = element('div', 'search-progress'); feedback.id = 'search-feedback'; feedback.setAttribute('role', 'status');
    if (state.loading) {
      const spinner = element('span', 'loading-spinner'); spinner.setAttribute('aria-hidden', 'true'); feedback.append(spinner);
      const analyzing = state.stage === 'interpreting';
      feedback.classList.toggle('analysis-active', analyzing);
      feedback.append(element('span', '', analyzing ? 'Analyzing your request' : `${count} / 24 videos ? ${state.stage === 'authorizing' ? 'Complete sign-in to continue?' : state.stage === 'waiting-connector' ? 'Retrying automatically?' : 'Finding more?'}`));
      const elapsed = element('span', 'loading-time'); elapsed.id = 'loading-time'; feedback.append(elapsed);
      const cancel = element('button', 'outline-button', 'Cancel search'); cancel.addEventListener('click', cancelLiveSearch); feedback.append(cancel);
    } else feedback.append(element('span', '', count ? `${count} videos available. Some searches could not finish; see Advanced for details.` : `Search stopped. ${liveMessages[state.liveError] ?? liveMessages.REQUEST_FAILED}`));
    container.before(feedback); updateLoadingTime();
  } else if (state.loading) {
    const cancel = element('button', 'subtle-button', 'Stop'); cancel.id = 'quiet-cancel'; cancel.setAttribute('aria-label', 'Stop finding more videos');
    cancel.addEventListener('click', cancelLiveSearch); document.querySelector('.topic-actions').prepend(cancel);
  }
  for (const [column, label] of [['direct', 'On your topic'], ['related', 'Related topics'], ['wildcard', 'Unexpected discoveries']]) {
    const section = element('section', `stream ${column}`), header = element('header', 'stream-header'), heading = element('div', 'stream-heading');
    const title = element('h3', '', label); title.id = `live-${column}`; section.setAttribute('aria-labelledby', title.id); heading.append(title);
    if (!idle) heading.append(element('span', 'stream-number', visibleResultLimit === 8 ? `${rows[column].length} / 8` : `${rows[column].length} videos`));
    header.append(heading); section.append(header);
    const videos = rows[column];
    const streamState = state.liveResult?.streams?.[column === 'related' ? 'adjacent' : column];
    const columnLoading = state.loading && !['complete', 'failed'].includes(streamState?.status);
    if (columnLoading && videos.length < 8) { const spinner = element('span', 'loading-spinner column-spinner'); spinner.setAttribute('aria-label', `Finding videos: ${label}`); heading.append(spinner); }
    for (const v of videos) { const tile = card(v); markPrevious(tile, false); section.append(tile); }
    if (!videos.length) section.append(element('div', 'empty', idle ? (column === 'direct' ? 'Your next search starts here.' : 'Connections to your next topic.') : columnLoading ? 'Finding videos…' : streamState?.status === 'failed' ? 'This search could not finish. Other results are still available.' : 'No additional videos matched this search and your filters.'));
    container.append(section);
  }
  if (Object.keys(rows).some(column => selected[column].length > rows[column].length)) {
    const more = element('button', 'outline-button more-results', 'Show more videos');
    more.type = 'button'; more.title = 'Show more of the results already received';
    const reveal = () => { if (!more.isConnected) return; resultObserver?.disconnect(); visibleResultLimit += 8; render(); };
    more.addEventListener('click', reveal); container.append(more);
    if (typeof IntersectionObserver === 'function') {
      resultObserver = new IntersectionObserver(entries => {
        if (window.scrollY > 0 && entries.some(entry => entry.isIntersecting)) reveal();
      }, { rootMargin: '0px 0px 300px 0px' });
      resultObserver.observe(more);
    }
  }
  $('context-line').textContent = 'Your topic, related topics and web discoveries. Previous discoveries are available in Past searches.';
  $('status').textContent = idle ? 'Ready for a new search.' : `${count} videos shown.${state.loading ? ' Finding more.' : ' Search finished.'}`;
  if (state.liveResult?.restored) $('status').textContent = state.liveResult.interrupted
    ? `${count} saved videos restored. The previous search was interrupted; start a new search to find more.`
    : `${count} saved videos restored from this device.`;
  persistLastPage();
}
function render() {
  resultObserver?.disconnect(); resultObserver = null;
  updateTabs();
  scheduleVideoDurations();
  document.querySelector('main').classList.remove('home-empty-view');
  document.querySelector('.collection-heading').hidden = false;
  if (state.loading && loadingTimer === null) loadingTimer = setInterval(updateLoadingTime, 1000);
  if (!state.loading && loadingTimer !== null) { clearInterval(loadingTimer); loadingTimer = null; }
  const container = $('streams');
  $('search-feedback')?.remove(); $('quiet-cancel')?.remove();
  const webLayout = !state.savedOnly && !homeMode && !subscriptionsMode && liveStatus.provider === 'chatgpt_web';
  $('home-tab').setAttribute('aria-pressed', String(homeMode && !state.savedOnly));
  $('subscriptions-tab').setAttribute('aria-pressed', String(subscriptionsMode && !state.savedOnly));
  $('search-tab').hidden = !state.query;
  $('search-tab').setAttribute('aria-pressed', String(!homeMode && !subscriptionsMode && !state.savedOnly));
  $('current-topic').hidden = false; $('new-search').textContent = 'New search';
  $('search-invitation').hidden = true;
  document.querySelector('main').classList.toggle('search-idle', webLayout && state.query === null);
  document.querySelector('main').classList.toggle('search-layout', webLayout);
  container.classList.remove('two-column-search');
  renderCardCache = new Map([...container.querySelectorAll('.video-card')].map(node => [node.getAttribute('data-video-id'), node]));
  container.replaceChildren();
  $('current-topic').classList.toggle('query-loading', state.loading && !homeMode);
  $('current-topic').setAttribute('aria-busy', String(state.loading && !homeMode));
  container.classList.remove('home-results');
  if (webLayout) { renderWebSearch(container); return; }
  if (homeMode || subscriptionsMode || state.savedOnly) { renderHome(container); return; }
  $('collection-note').hidden = true;
  container.setAttribute('aria-busy', String(state.loading));
  const searching = state.query !== null;
  const live = searching && state.source === 'live';
  const hasPrevious = Object.values(previousSearchRows).some(rows => rows.length);
  const discovery = live && (state.liveResult?.streams || hasPrevious);
  $('result-count').hidden = Boolean(live && (!state.liveResult || (state.loading && !state.liveResult.videos.length)));
  container.classList.toggle('catalog-results', searching && !discovery);
  $('current-topic').textContent = searching ? (state.query.length > 100 ? state.query.slice(0, 100) + '…' : state.query) : 'NASA · Challenger · Engineering failures';
  $('current-topic').title = searching ? state.query : '';
  $('review-request').hidden = !searching;
  if ($('request-dialog').open || $('request-dialog').hasAttribute('open')) renderRequest();
  $('ai-button').hidden = searching;
  $('method-switch').hidden = searching;
  $('hidden-count').textContent = state.hidden.size ? `${state.hidden.size} hidden · Reset view to restore` : '';
  $('collection-note').textContent = live ? `YouTube / ChatGPT discovery / ${state.liveResult?.preferences?.minMinutes ?? state.minMinutes}-${state.liveResult?.preferences?.maxMinutes ?? state.maxMinutes} minutes` : searching ? `Local search · ${SNAPSHOT.catalog.length} cached videos · Nov 7, 2026` : 'YouTube · Collected Nov 7, 2026';
  if (state.liveResult?.provider === 'chatgpt_web') $('collection-note').textContent = 'ChatGPT web search · Length and language preferences are not verified';
  if (!live && Date.now() >= Date.parse(SNAPSHOT.expires_at)) {
    $('result-count').textContent = '0';
    container.append(element('div', 'expired', 'This saved collection has expired. Refresh its source data and rebuild the preview to continue. No automatic requests have been made.')); return;
  }
  if (searching) {
    if (live && !state.liveResult && !hasPrevious) {
      $('result-count').textContent = ''; $('collection-title').firstChild.textContent = state.loading ? 'Searching ' : 'Search ';
      const panel = element('div', 'empty catalog-empty');
      if (state.loading) { const spinner = element('span', 'loading-spinner'); spinner.setAttribute('aria-hidden', 'true'); panel.append(spinner); }
      const progress = state.stage === 'waiting-connector' ? 'Previous search is finishing. Retrying automatically…' : state.stage === 'web-search' ? 'ChatGPT is finding videos on the web…' : state.stage === 'retrying' ? 'YouTube is busy. Retrying shortly…' : state.stage === 'authorizing' ? 'Sign in to ChatGPT to continue your search...' : state.stage === 'refining' ? 'Refining your searches…' : state.stage === 'planning' ? 'Finding first results while ChatGPT prepares more…' : 'Finding videos on YouTube…';
      panel.append(element('strong', '', state.loading ? progress : 'Search did not complete.'),
        element('p', '', state.loading ? state.stage === 'web-search' ? '0 / 45 videos · Searching three directions. Results appear automatically.' : 'Results appear as each search finishes. Complete sign-in if prompted.' : liveMessages[state.liveError] ?? liveMessages.REQUEST_FAILED));
      if (state.loading) {
        const elapsed = element('p', 'loading-time'); elapsed.id = 'loading-time'; elapsed.setAttribute('aria-hidden', 'true'); panel.append(elapsed);
        const cancel = element('button', 'outline-button', 'Cancel search');
        cancel.addEventListener('click', cancelLiveSearch);
        panel.append(cancel);
      } else if (['RATE_LIMITED', 'QUOTA_EXCEEDED', 'ACCESS_OR_QUOTA_DENIED', 'PROVIDER_UNAVAILABLE'].includes(state.liveError)) {
        panel.append(element('p', '', 'No cached results are available for this search.'));
        const link = element('a', 'outline-button', 'Continue on YouTube ↗');
        link.setAttribute('href', `https://www.youtube.com/results?search_query=${encodeURIComponent(state.query)}`);
        link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; panel.append(link);
      }
      container.append(panel); updateLoadingTime(); $('status').textContent = state.loading ? `${progress} Complete sign-in if prompted.` : panel.textContent;
      return;
    }
    if (live && state.liveResult && Date.now() - Date.parse(state.liveResult.fetched_at) >= 30 * 86400000) {
      state.liveResult = null; state.liveError = 'REQUEST_FAILED'; render(); return;
    }
    const matches = live ? filterLiveResults(state.liveResult?.videos ?? [], state) : searchCatalog(SNAPSHOT.catalog, state.query, state);
    if (live && state.liveResult && (state.liveResult.provisional || state.liveResult.warning) && !(discovery && state.loading)) {
      const note = element('p', 'search-progress');
      note.textContent = state.liveResult.provisional_source === 'interests' ? 'Live search unavailable · Suggestions from your saved interests'
        : state.liveError === 'CANCELLED' ? 'Search stopped · Keeping available results'
        : state.liveResult.warning ? 'Live search paused · Keeping available results'
        : state.liveResult.provisional_source === 'cache' ? (state.loading ? 'Cached matches · Finding fresh suggestions…' : 'Cached matches · No fresh results found')
        : state.loading ? 'First results · ChatGPT is refining your selection…' : 'Direct YouTube results';
      if (state.loading && !discovery) {
        const cancel = element('button', 'outline-button', 'Cancel search');
        cancel.addEventListener('click', cancelLiveSearch);
        note.append(cancel);
      }
      container.append(note);
    }
    if (discovery) {
      const webSearch = state.liveResult?.provider === 'chatgpt_web' || hasPrevious;
      const freshRows = Object.fromEntries(STREAMS.map(stream => {
        const eligible = selectDiscoveryRows(state.liveResult?.provisional_source === 'cache' ? [] : matches, stream, 60);
        const projected = projectOrderedVideos(eligible, arrivalOrder[stream], webSearch ? 15 : 12);
        arrivalOrder[stream] = projected.order;
        return [stream, projected.rows];
      }));
      const allFreshIds = new Set(Object.values(freshRows).flat().map(video => video.video_id));
      const shown = allFreshIds.size;
      if (state.loading || state.liveError || webSearch) {
        const progress = element('div', 'search-progress');
        if (state.loading) { const spinner = element('span', 'loading-spinner'); spinner.setAttribute('aria-hidden', 'true'); progress.append(spinner); }
        progress.setAttribute('role', 'status');
        progress.append(element('span', '', webSearch && !state.liveError
          ? `${shown} / 45 new videos · ${state.loading ? (state.stage === 'waiting-connector' ? 'Previous search finishing; retrying automatically…' : state.stage === 'authorizing' ? 'Complete sign-in to continue…' : shown < 45 ? `Finding more · ${45 - shown} to reach the goal…` : 'Finishing selection…') : 'Search finished'}`
          : state.loading
          ? state.stage === 'refining' ? 'Broadening your searches…' : state.stage === 'exploring' ? 'Exploring different angles…' : 'Finding more videos…'
          : `Search stopped. ${liveMessages[state.liveError] ?? liveMessages.REQUEST_FAILED}`));
        if (state.loading) {
          const elapsed = element('span', 'loading-time'); elapsed.id = 'loading-time'; progress.append(elapsed);
          const cancel = element('button', 'outline-button', 'Cancel search');
          cancel.addEventListener('click', cancelLiveSearch);
          progress.append(cancel);
        }
        container.append(progress); updateLoadingTime();
      }
      let count = 0;
      for (const stream of STREAMS) {
        const rows = freshRows[stream]; count += rows.length;
        const previous = previousSearchRows[stream] ?? [];
        const allowed = new Set(filterLiveResults(previous, state).map(video => video.video_id));
        const retained = previous.filter(video => allowed.has(video.video_id));
        const slots = replacementColumn(rows, retained, allFreshIds, webSearch ? 15 : 12);
        lastSearchRows[stream] = slots.map(slot => slot.video);
        const section = element('section', `stream ${stream}`), header = element('header', 'stream-header');
        const heading = element('div', 'stream-heading');
        heading.append(element('span', 'stream-letter', copy[stream][0]), element('h3', '', copy[stream][1]), element('span', 'stream-number', webSearch ? `${rows.length} / 15` : `${rows.length} picks`));
        header.append(heading); section.append(header);
        let previousBoundaryShown = false;
        for (const slot of slots) {
          if (slot.previous && !previousBoundaryShown) {
            const boundary = element('hr', 'previous-results-boundary');
            boundary.setAttribute('aria-label', 'Previous search results below');
            section.append(boundary); previousBoundaryShown = true;
          }
          const tile = card(slot.video);
          markPrevious(tile, slot.previous);
          section.append(tile);
        }
        if (!slots.length) section.append(element('div', 'empty', state.loading ? 'Searching this direction…' : 'No videos match this direction and your current settings.'));
        container.append(section);
      }
      $('result-count').textContent = count;
      $('collection-title').firstChild.textContent = state.savedOnly ? 'Saved ' : 'Discoveries ';
      $('context-line').textContent = 'Three ChatGPT search directions. Duplicate videos are shown once. Connections are hypotheses, not quality ratings.';
      $('status').textContent = `${count} discoveries shown.${state.loading ? ' More searches are running.' : state.liveError ? ' Search stopped.' : ''}`;
      return;
    }
    $('result-count').textContent = matches.length;
    $('collection-title').firstChild.textContent = state.savedOnly ? 'Saved matches ' : state.liveResult?.provisional_source === 'interests' ? 'From your interests ' : live ? 'YouTube results ' : 'Local matches ';
    $('context-line').textContent = live ? `Retrieved ${state.liveResult.search_results} search results; ${matches.length} match the duration and current filters. No AI-generated discovery streams.` : 'Keyword matches in the saved collection. No live YouTube search or AI-generated discovery streams.';
    for (const v of matches) container.append(card(v));
    if (!matches.length) {
      const empty = element('div', 'empty catalog-empty');
      empty.append(element('strong', '', live ? 'No videos on this result page match the current limits.' : 'No matching videos in this local collection.'),
        element('p', '', live ? 'Only the first search page is checked. Unknown durations, live videos and videos outside your length preference are excluded. Try another query or reset the filters.' : `MyTube searched its ${SNAPSHOT.catalog.length} cached videos, not YouTube. Search YouTube for fresh results, or change the local keywords and filters.`));
      container.append(empty);
    }
    $('status').textContent = `${matches.length} ${live ? 'YouTube results' : 'local matches'} for ${state.query}.`;
    return;
  }
  const rows = visibleRows(SNAPSHOT, state), total = Object.values(rows).reduce((n, r) => n + r.length, 0);
  $('result-count').textContent = total;
  $('collection-title').firstChild.textContent = state.savedOnly ? 'Saved ' : 'Videos ';
  $('hidden-count').textContent = state.hidden.size ? `${state.hidden.size} hidden · Reset view to restore` : '';
  $('context-line').textContent = state.savedOnly ? 'Saved for this session only. Filters still apply.'
    : state.method === 'diversified' ? 'Three separate discovery strategies. No video appears twice.' : 'Reference order from the same collected candidates. No video appears twice.';
  for (const s of STREAMS) {
    const section = element('section', `stream ${s}`), header = element('header', 'stream-header'), heading = element('div', 'stream-heading');
    const title = element('h3', '', copy[s][1]); title.id = `stream-${s}`; section.setAttribute('aria-labelledby', title.id);
    heading.append(element('span', 'stream-letter', copy[s][0]), title, element('span', 'stream-number', `${rows[s].length} picks`));
    header.append(heading); section.append(header);
    for (const v of rows[s]) section.append(card(v));
    if (!rows[s].length) {
      const empty = element('div', 'empty'); empty.append(element('strong', '', state.savedOnly ? 'Nothing saved here yet.' : 'No picks match this view.'),
        document.createTextNode(state.savedOnly ? 'Use the + on a video to keep it for this session.' : 'Try a different filter or reset the view.'));
      section.append(empty);
    }
    container.append(section);
  }
  $('status').textContent = `${total} videos shown.`;
}
function renderAi() {
  const panel = $('ai-panel');
  panel.append(element('h2', '', 'Saved search drafts'),
    element('p', '', 'ChatGPT proposed these underlying interests and search directions in our saved experiment. They are hypotheses, not facts about you. These searches have not been run and did not produce the videos below.'));
  const list = element('ul', 'interest-list');
  for (const interest of SNAPSHOT.ai.underlying_interests) list.append(element('li', '', interest));
  panel.append(list);
  const columns = element('div', 'ai-streams');
  for (const s of STREAMS) {
    const column = element('div'); column.append(element('h3', '', copy[s][1]));
    for (const q of SNAPSHOT.ai.streams[s].queries) {
      const row = element('p', 'ai-query', q.query); row.append(element('small', '', q.why));
      if (s === 'wildcard' && q.query.includes('Gustave Mesny')) row.append(element('small', 'review-flag', 'Needs factual review: this person/topic association is unverified.'));
      column.append(row);
    }
    columns.append(column);
  }
  panel.append(columns);
}
$('search').addEventListener('input', event => { state.search = event.target.value; render(); });
const preferenceControls = bindPreferenceControls({ document, getPreferences: () => viewingPreferences,
  onChange(preferences, renderResults) {
    viewingPreferences = preferences;
    state.minMinutes = preferences.minMinutes; state.maxMinutes = preferences.maxMinutes;
    persistViewingPreferences();
    if (renderResults) render();
  },
});
function syncPreferences() { preferenceControls.sync(); }
function syncDurationSettings() { preferenceControls.syncDuration(); }
$('youtube-key-setup').addEventListener('click', async () => {
  const button = $('youtube-key-setup'), status = $('youtube-key-status');
  button.disabled = true;
  try {
    if (!globalThis.MyTubeLive?.setupYouTubeKey) throw new Error();
    await globalThis.MyTubeLive.setupYouTubeKey();
    status.textContent = 'Finish in the Windows key window. After saving, start a new search.';
  } catch { status.textContent = 'Could not open Windows setup. Check the connector, or run npm.cmd run key:setup in your own Windows terminal.'; }
  finally { button.disabled = false; }
});
$('settings-search').addEventListener('click', () => { $('settings-dialog').close(); openQuery(state.query ?? '', true); });
$('settings-button').addEventListener('click', () => { syncPreferences(); syncHomeSettings(); $('settings-search').hidden = !state.query; $('signout-chatgpt').hidden = !liveStatus.ready; $('settings-dialog').showModal(); });
$('languages-button').addEventListener('click', () => { syncPreferences(); $('languages-dialog').showModal(); });
$('past-searches-button').addEventListener('click', () => { cancelQueryConnection(); renderPastSearches(); $('past-searches-dialog').showModal(); });
$('close-past-searches').addEventListener('click', () => { $('past-searches-dialog').close(); $('past-searches-button').focus(); });
$('blocked-channels-button').addEventListener('click', () => { $('settings-dialog').close(); syncBlockedChannels(); $('blocked-channels-dialog').showModal(); });
$('close-blocked-channels').addEventListener('click', () => { $('blocked-channels-dialog').close(); $('settings-button').focus(); });
$('history-button').addEventListener('click', () => { $('settings-dialog').close(); syncHomeSettings(); $('history-dialog').showModal(); });
for (const panel of ['languages', 'history']) {
  for (const action of ['close', 'done']) $(`${action}-${panel}`).addEventListener('click', () => {
    $(`${panel}-dialog`).close(); $(panel === 'history' ? 'remember-interests' : 'languages-button').focus();
  });
}
$('signout-chatgpt').addEventListener('click', async () => {
  const button = $('signout-chatgpt'); button.disabled = true;
  $('session-status').textContent = 'Signing out...';
  try { await globalThis.MyTubeLive.signOut(); $('session-status').textContent = 'Signed out of ChatGPT. Your next search will ask you to connect.'; }
  catch (error) { $('session-status').textContent = liveMessages[error?.code] ?? 'Sign-out could not complete.'; }
  finally { button.disabled = false; }
});
for (const id of ['close-settings', 'done-settings']) $(id).addEventListener('click', () => { $('settings-dialog').close(); $('settings-button').focus(); });
for (const method of ['diversified', 'search_baseline']) $(method).addEventListener('click', () => {
  state.method = method;
  for (const m of ['diversified', 'search_baseline']) { $(m).classList.toggle('selected', m === method); $(m).setAttribute('aria-pressed', String(m === method)); }
  render();
});
function showHome(event) {
  event?.preventDefault(); state.savedOnly = false; homeMode = true; subscriptionsMode = false; render();
}
document.querySelector('.brand').addEventListener('click', showHome);
$('home-tab').addEventListener('click', showHome);
$('search-tab').addEventListener('click', () => { homeMode = false; subscriptionsMode = false; state.savedOnly = false; render(); });
$('subscriptions-tab').addEventListener('click', () => { homeMode = false; subscriptionsMode = true; state.savedOnly = false; render(); });
$('saved-tab').addEventListener('click', () => { state.savedOnly = !state.savedOnly; homeMode = state.query === null; render(); });
$('refresh-home').addEventListener('click', () => refreshPersonalHome(true));
bindHistoryControls({ document, isEnabled: () => home.enabled, sync: syncHomeSettings,
  enable() { home.enabled = true; persistHome(); syncHomeSettings(); render(); },
  clear: clearHistory,
});
function clearHistory(disable) {
  homeRefresh.cancel(); subscriptionRequest.cancel(); subscriptionVideos = []; subscriptionLoaded = false; subscriptionNext = null;
  archiveRows = []; currentArchive = null; void archive.clear();
  try { homeStorage?.setItem(ARCHIVE_CLEAR_KEY, String(Date.now())); } catch {}
  homeEpoch++; home = { ...emptyHome(), enabled: disable ? false : home.enabled };
  lastPageWritable = false; clearLastSearch(homeStorage);
  state.saved.clear(); state.hidden.clear(); recentVideos = []; lastFreshVideos = []; homeNotice = 'Interests and cache cleared.'; persistHome(); syncHomeSettings(); render();
  if ($('past-searches-dialog').hasAttribute('open')) renderPastSearches();
}

globalThis.addEventListener?.('storage', event => {
  if (event.key === ARCHIVE_CLEAR_KEY) {
    homeEpoch++; archiveRows = []; currentArchive = null; lastPageWritable = false;
    subscriptionRequest.cancel(); subscriptionVideos = []; subscriptionNext = null;
    if (homeMode || subscriptionsMode) render();
    if ($('past-searches-dialog').hasAttribute('open')) renderPastSearches();
    return;
  }
  if (event.key === LAST_SEARCH_KEY && (!event.newValue || event.newValue === 'null')) { lastPageWritable = false; return; }
  if (event.key === VIEWING_PREFERENCES_KEY) {
    viewingPreferences = loadViewingPreferences(homeStorage);
    state.minMinutes = viewingPreferences.minMinutes; state.maxMinutes = viewingPreferences.maxMinutes;
    syncPreferences(); render(); return;
  }
  if (event.key !== HOME_KEY) return;
  homeRefresh.cancel(); homeEpoch++; home = loadHome(homeStorage);
  if (!home.enabled) { lastPageWritable = false; clearLastSearch(homeStorage); archiveRows = []; currentArchive = null; void archive.clear(); }
  state.saved = new Set(home.saved); state.hidden = new Set(home.hidden);
  if (!state.query) recentVideos = pastSearchPicks(home);
  syncHomeSettings(); render();
});
$('reset').addEventListener('click', () => {
  state.search = ''; state.duration = 'all'; state.minMinutes = 20; state.maxMinutes = 120; state.hidden.clear();
  viewingPreferences.minMinutes = 20; viewingPreferences.maxMinutes = 120;
  persistViewingPreferences();
  $('search').value = ''; syncDurationSettings(); render();
});
$('ai-button').addEventListener('click', () => { const open = $('ai-panel').hidden; $('ai-panel').hidden = !open; $('ai-button').setAttribute('aria-expanded', String(open)); });
for (const id of ['about-button', 'privacy-button']) $(id).addEventListener('click', () => { $('settings-dialog').close(); $('about-dialog').showModal(); });
$('close-about').addEventListener('click', () => $('about-dialog').close());
const queryDialog = createQueryDialog({ document, getStatus: () => liveStatus,
  getProvider: () => globalThis.MyTubeLive, updateHelp: updateQueryHelp, messages: liveMessages,
  cancelSearch() { searchLifecycle.cancel(); render(); },
});
function openQuery(text, editing = false) { return queryDialog.open(text, editing); }
function cancelQueryConnection() { queryDialog.cancel(); }
function renderRequest() {
  renderSearchDetails(document, { query: state.query, result: state.liveResult,
    error: state.liveError, loading: state.loading, version: SNAPSHOT.preview_version }, liveMessages);
}
$('new-search').addEventListener('click', () => openQuery(intentionDraft || state.query || ''));
$('review-request').addEventListener('click', () => { $('settings-dialog').close(); renderRequest(); $('request-dialog').showModal(); });
$('close-request').addEventListener('click', () => { $('request-dialog').close(); $('settings-button').focus(); });
$('edit-request').addEventListener('click', () => {
  $('request-dialog').close(); openQuery(state.query ?? '', true);
});
for (const id of ['close-query', 'cancel-query']) $(id).addEventListener('click', () => $('query-dialog').close());
function changeTopic(query, source = 'local', liveQuery = null) {
  lastPageWritable = true;
  searchLifecycle.cancel();
  const past = homeMode ? pastSearchPicks(home) : [...lastFreshVideos, ...recentVideos];
  recentVideos = uniqueVideos(past).slice(0, 8);
  lastFreshVideos = []; liveArrivalOrder = {}; visibleResultLimit = 8;
  previousSearchRows = source === 'live' ? (homeMode ? rowsByColumn([...homePicks(home).recent, ...homePicks(home).lasting]) : lastSearchRows) : {};
  lastSearchRows = {}; arrivalOrder = {};
  $('interpreted-request').hidden = true;
  state.query = query; state.source = source; state.liveQuery = liveQuery;
  state.liveResult = null; state.liveError = null; state.loading = false;
  state.search = ''; state.savedOnly = false;
  $('search').value = '';
  $('ai-panel').hidden = true; $('ai-button').setAttribute('aria-expanded', 'false');
  render();
}
const queryInterpretation = createQueryInterpretation({ document, getProvider: () => globalThis.MyTubeLive, messages: liveMessages,
  onAnswerStart(query) {
    changeTopic(query, 'live', query);
    homeMode = false; subscriptionsMode = false; homeRefresh.cancel();
    state.loading = true; state.stage = 'interpreting'; loadingStartedAt = Date.now(); render();
  },
  onAnswerEnd() { state.loading = false; render(); },
});
$('query-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (queryDialog.connecting || $('query-input').disabled) return;
  const query = $('query-input').value.trim();
  intentionDraft = $('query-input').value;
  if (query.length > 6000) { $('query-error').textContent = 'Keep your description within 6,000 characters.'; return; }
  if (!/[\p{L}\p{N}]/u.test(query)) {
    $('query-error').textContent = 'Enter a topic or at least one specific keyword.';
    $('query-input').focus(); return;
  }
  updateQueryHelp();
  if (!liveStatus.ready) { $('query-error').textContent = liveMessages[liveStatus.reason] ?? 'YouTube search is unavailable.'; return; }
  const preferences = validatePreferences(viewingPreferences);
  let interpreted;
  if (globalThis.MyTubeLive.interpret) {
    searchLifecycle.cancel(); render();
    interpreted = await queryInterpretation.prepare(query, preferences);
    if (!interpreted) return;
  }
  const searchIntention = interpreted?.search_intention ?? query;
  changeTopic(query, 'live', searchIntention); $('query-dialog').close(); $('new-search').focus();
  if (interpreted) { $('interpreted-request').textContent = interpreted.summary; $('interpreted-request').hidden = false; }
  homeMode = false; subscriptionsMode = false; homeRefresh.cancel(); const searchEpoch = homeEpoch;
  currentArchive = { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, at: Date.now(), query, intention: searchIntention, epoch: homeEpoch };
  archiveResult();
  loadingStartedAt = Date.now();
  await searchLifecycle.run((signal, stage, progress) => globalThis.MyTubeLive.discover(
    searchIntention, signal, stage, progress, preferences, { cached: cachedSearchPicks(home, searchIntention), preparedPlan: interpreted?.plan }), {
    partial(result) {
      archiveResult(result);
      if (result.provisional_source === 'cache' && !Object.values(previousSearchRows).some(rows => rows.length)) previousSearchRows = rowsByColumn(result.videos);
    },
    complete(result) {
      archiveResult(result);
      if (searchEpoch === homeEpoch) { home = rememberHome(home, { ...result, videos: result.videos.map(withKnownDuration) }); persistHome(); }
    },
  });
});
function updateQueryHelp() {
  liveStatus = detectLiveStatus(globalThis.MyTubeLive, globalThis.browser ?? globalThis.chrome, globalThis.location?.protocol);
  $('submit-query').disabled = !liveStatus.ready;
  $('query-help').hidden = liveStatus.ready;
  $('query-help').textContent = liveStatus.ready ? '' : liveMessages[liveStatus.reason] ?? 'Live search is unavailable.';
  const diagnostic = $('live-diagnostic');
  if (diagnostic) diagnostic.textContent = `Page: ${globalThis.location?.protocol === 'file:' ? 'local file' : 'extension/browser preview'} · Version: ${liveStatus.version ?? SNAPSHOT.preview_version} · Google client: ${liveStatus.clientConfigured ? 'configured' : 'not loaded'} · Live status: ${liveStatus.ready ? 'ready for sign-in test' : liveStatus.reason}`;
}
$('query-input').addEventListener('input', () => { intentionDraft = $('query-input').value; $('query-error').textContent = ''; });
{
  const setup = element('details'); setup.append(element('summary', '', 'Developer setup'));
  if (liveStatus.extensionId) setup.append(element('p', '', `Extension ID: ${liveStatus.extensionId}`));
  const diagnostic = element('p'); diagnostic.id = 'live-diagnostic'; setup.append(diagnostic);
  $('about-dialog').append(setup);
}
updateQueryHelp();
syncPreferences();
syncHomeSettings();
renderAi(); render();
if (homeMode) setTimeout(() => refreshPersonalHome(), 250);

// Migrate existing cache without deleting it. Opening starts with recommendations;
// the retained three-column search remains available through Last search.
const archiveEpoch = homeEpoch;
archive.load().then(async rows => {
  if (archiveEpoch !== homeEpoch) return;
  if (!home.enabled) { await archive.clear(); return; }
  archiveRows = [...archiveRows, ...(rows ?? []).filter(r => !archiveRows.some(v => v.id === r.id))];
  for (const topic of home.topics) {
    const id = `legacy:${topic.label}:${topic.updatedAt}`;
    if (archiveRows.some(r => r.id === id || topic.videos.length && topic.videos.every(v => r.videos.some(saved => saved.video_id === v.video_id)))) continue;
    const row = { id, at: topic.updatedAt, query: topic.label, intention: topic.label, videos: topic.videos, count: topic.videos.length };
    archiveRows.push(row); await archive.put(row);
    if (archiveEpoch !== homeEpoch) return;
  }
  if (restoredPage && !archiveRows.some(r => r.query === restoredPage.query)) {
    const row = { id: 'legacy:last-search', at: Date.now(), query: restoredPage.query, intention: restoredPage.query,
      videos: restoredPage.videos, count: restoredPage.videos.length };
    archiveRows.push(row); await archive.put(row);
  }
  if (archiveEpoch === homeEpoch && homeMode) render();
});
