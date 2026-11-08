import { createElementFactory } from './dom.mjs';
import { STREAMS, syntheticProductionSignals } from './model.mjs';
import { PREFERENCE_AXES } from '../extension/preferences.mjs';

// Diagnostic rendering receives a snapshot and never starts or alters a search.
export function renderSearchDetails(document, { query, result, error, loading, version }, messages) {
  const $ = id => document.getElementById(id);
  const element = createElementFactory(document);
  $('original-request').textContent = query ?? '';
  const queries = $('generated-searches'); queries.replaceChildren();
  if (error) queries.append(element('p', 'settings-note', `Search status: ${error} · MyTube ${version}`));
  if (result?.quick_query) queries.append(element('p', 'generated-query', `Quick search: ${result.quick_query}`));
  if (result?.provider === 'chatgpt_web') queries.append(element('p', 'settings-note', `ChatGPT web search · ${result.web_searches} searches · Links checked with YouTube. Length, publication date and view counts are unavailable.`));
  if (!result?.streams) {
    queries.append(element('p', '', error ? 'No completed search plan is available.' : 'Search details will appear here when this search completes.')); return;
  }
  if (result.preferences) {
    const p = result.preferences;
    queries.append(element('p', 'settings-note', `Preferences: ${PREFERENCE_AXES.map(k => `${k} ${p[k]}`).join(' / ')} / ${p.minMinutes}-${p.maxMinutes} min / ${p.languages.join(', ')}`));
  }
  for (const adjustment of result.adjustments ?? []) {
    const detail = element('details', 'search-adjustment');
    detail.append(element('summary', '', adjustment.reason === 'NO_RESULTS' ? 'Searches broadened automatically: no matching videos.' : 'Search plan corrected automatically.'));
    if (adjustment.previous_queries.length) {
      detail.append(element('h4', '', 'First attempt'));
      for (const q of adjustment.previous_queries) detail.append(element('p', 'generated-query', q.query));
    }
    detail.append(element('h4', '', 'Revised searches'));
    for (const q of adjustment.queries) detail.append(element('p', 'generated-query', q.query));
    queries.append(detail);
  }
  for (const stream of STREAMS) {
    const direction = result.streams[stream];
    const row = element('section', 'generated-search');
    row.append(element('h4', '', ({ direct: '1 · On your topic (DIRECT)', adjacent: '2 · Related topics (ADJACENT)', wildcard: '3 · Jokers (WILDCARD)' })[stream]));
    row.append(element('p', 'settings-note', `Status: ${direction.status ?? (loading ? 'searching' : 'complete')} · ${direction.videos?.length ?? 0} candidates in this column`));
    if (direction.web_error) row.append(element('p', '', `Web exploration: ${messages[direction.web_error] ?? direction.web_error}. YouTube API results are retained separately.`));
    if (direction.retry_reason) row.append(element('p', 'settings-note', 'Another related query was tried because fewer than four distinct candidates were available.'));
    if (!direction.searches?.length && !direction.query) row.append(element('p', '', stream === 'wildcard' ? 'ChatGPT searches the web for this column.' : 'Waiting for the search plan.'));
    for (const search of direction.searches ?? [{ query: direction.query }]) {
      row.append(element('p', 'generated-query', search.query));
      if (search.platforms?.length) row.append(element('p', 'settings-note', `Platforms searched: ${search.platforms.join(', ')}`));
      if (Number.isInteger(search.candidates)) row.append(element('p', '', `${search.candidates} candidates after language and length filters.`));
      if (search.status === 'failed') row.append(element('p', '', messages[direction.error] ?? 'Search did not complete.'));
      if (search.off_topic_filtered) row.append(element('p', '', `${search.off_topic_filtered} candidates excluded: no direct-subject match in title or introductory description.`));
    }
    if (direction.subjects?.length) row.append(element('p', '', `Direct subject aliases: ${direction.subjects.join(', ')}`));
    const reason = element('details'); reason.append(element('summary', '', 'ChatGPT explanation'), element('p', '', direction.why));
    row.append(reason); queries.append(row);
  }
  const timing = result.timing_ms;
  const excludedSynthetic = result.videos.filter(v => syntheticProductionSignals(v).length).length;
  if (excludedSynthetic) queries.append(element('p', '', `${excludedSynthetic} videos excluded for explicit synthetic-production disclosures. Undisclosed AI-generated content may remain.`));
  if (timing) queries.append(element('p', 'search-timing', `${Number.isFinite(timing.planning) ? `ChatGPT preparation: ${(timing.planning / 1000).toFixed(1)}s · ` : ''}First results: ${timing.first_results === null ? 'pending' : (timing.first_results / 1000).toFixed(1) + 's'} · ${loading ? 'Elapsed' : 'Total'}: ${(timing.total / 1000).toFixed(1)}s. Sign-in time, if needed, is included.`));
}
