// Reproducible coverage check over existing, hash-verified public metadata.
// No account access, new requests, ratings, or content-quality claims.
import { writeFile } from 'node:fs/promises';
import { loadCatalog } from './catalog.mjs';
import { institutionalSignals, searchCatalog } from './model.mjs';

const catalog = await loadCatalog();
const state = { search: '', duration: 'all', preferInstitutions: true,
  hidden: new Set(), saved: new Set(), savedOnly: false };
const summarize = rows => ({
  videos: rows.length,
  with_format_or_institution_hints: rows.filter(v => institutionalSignals(v).length > 0).length,
  distinct_channel_names: new Set(rows.map(v => v.channel.trim().toLowerCase()).filter(Boolean)).size,
});
const report = {
  status: 'CACHED_CANDIDATE_COVERAGE_CHECKED',
  recorded_at: new Date().toISOString(),
  source_sha256: catalog.hashes,
  network_requests: 0,
  inference_requests: 0,
  catalog: summarize(catalog.videos),
  topics: ['mathematics', 'history', 'aviation', 'nuclear'].map(query => {
    const baseline = searchCatalog(catalog.videos, query, { ...state, preferInstitutions: false });
    const preferred = searchCatalog(catalog.videos, query, state);
    return { query, matching_pool: summarize(preferred),
      keyword_top_ten: summarize(baseline.slice(0, 10)),
      default_top_ten: summarize(preferred.slice(0, 10)) };
  }),
  limitations: [
    'The catalog was collected for earlier experiments; this is not fresh YouTube coverage.',
    'Title/channel-name hints do not verify format, affiliation, credibility, or quality.',
    'Channel names are a proxy until stable channel IDs are available.',
    'Counts do not establish relevance, personal novelty, or semantic discovery streams.',
    'Known 20–120 minute non-live videos only; longer proceedings are outside this pool.',
  ],
  quality_verdict: null,
};
await writeFile(new URL('../results/candidate-coverage.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ catalog: report.catalog, topics: report.topics }, null, 2));
