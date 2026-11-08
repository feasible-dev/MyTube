import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { SafeError, createClient, toCsv } from '../b1-youtube-candidates/core.mjs';
import { readKey } from '../b1-youtube-candidates/key-input.mjs';
import { collectExperiment, rankExperiment, streams, validateExperiment } from './core.mjs';

const root = new URL('../../', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const mode = process.argv[2] ?? '--plan';
if (process.argv.length > 3 || !['--plan', '--cached', '--live'].includes(mode)) {
  console.error('Usage: node spikes/b1-controlled-discovery/run.mjs [--plan|--cached|--live]');
  process.exitCode = 2;
} else {
  const id = `${Date.now()}-${randomUUID()}`;
  const report = { spike: 'B1.1', run_id: id, recorded_at: new Date().toISOString(), mode,
    status: 'BLOCKED', verdict: null, requests: [], inference_requests: 0, oauth_attempts: 0,
    manual_ratings_created: false, quality_assessed: false, source_sha256: {}, output_sha256: {} };
  let key;
  try {
    const plan = validateExperiment(JSON.parse(await readFile(new URL('./plan.json', import.meta.url), 'utf8')));
    for (const path of ['spikes/b1-controlled-discovery/plan.json', 'spikes/b1-controlled-discovery/core.mjs',
      'spikes/b1-controlled-discovery/run.mjs', 'spikes/b1-controlled-discovery/discovery.test.mjs',
      'spikes/b1-youtube-candidates/core.mjs', 'spikes/b1-youtube-candidates/key-input.mjs']) {
      report.source_sha256[path] = hash(await readFile(new URL(path, root)));
    }
    report.limits = { search_requests: 12, metadata_requests: 6, results_per_query: 25,
      pagination: false, retries: 0, inference_requests: 0 };
    report.plan = plan;
    if (mode === '--plan') {
      report.status = 'PLAN_VALIDATED_NO_REQUESTS';
    } else {
      let data;
      if (mode === '--cached') {
        const path = 'results/b1/1794078880207-7c695f76-0cf1-4fcd-9bf2-bb8aa9416367/candidates.json';
        const bytes = await readFile(new URL(path, root));
        if (hash(bytes) !== 'e27363f2380f2905da10314d30c2b1df12a614fca9f43cc6ef949fe1426c33c5') {
          throw new SafeError('CACHED_CORPUS_HASH_MISMATCH');
        }
        const cached = JSON.parse(bytes);
        const unique = new Map();
        for (const v of cached.candidates) {
          const previous = unique.get(v.video_id);
          if (!previous) unique.set(v.video_id, { ...v, origins: [...v.origins] });
          else {
            previous.origins.push(...v.origins);
            previous.best_search_rank = Math.min(previous.best_search_rank, v.best_search_rank);
            previous.first_query_index = Math.min(previous.first_query_index, v.first_query_index);
          }
        }
        data = { candidates: streams.flatMap(intent => [...unique.values()].map(v => ({ ...v, intent, views: null }))) };
        report.source_corpus = { path, sha256: hash(bytes), unique_videos: unique.size };
        report.discovery_source = 'CACHED_B1_REPLAY';
        report.limitation = 'All streams reuse the old aviation/math/history pool. Original query provenance is preserved. This does not test the new NASA queries, independent retrieval, semantic understanding, or recommendation quality.';
      } else {
        console.log('MyTube B1.1: one NASA intention, three separate discovery strategies.');
        console.log('At most 12 searches + 6 metadata requests. No retries, AI, OAuth, or history access.');
        console.log('Entering the dedicated Google key starts collection. It stays in memory; Ctrl+C cancels.');
        key = await readKey();
        data = await collectExperiment(plan, createClient(key, report.requests));
        key = undefined;
        report.discovery_source = 'YOUTUBE_API_STREAM_QUERIES';
        report.unique_search_ids = data.unique_search_ids;
        report.missing_metadata_count = data.missing_metadata_ids.length;
      }
      const rankings = rankExperiment(plan, data.candidates);
      const path = `results/b11/${id}/`;
      await mkdir(new URL(path, root), { recursive: true });
      const selected = Object.entries(rankings.diversified).flatMap(([, rows]) => rows);
      const outputs = {
        'candidates.json': JSON.stringify(data, null, 2) + '\n',
        'rankings.json': JSON.stringify(rankings, null, 2) + '\n',
        'recommendations.csv': toCsv(['stream', 'rank', 'video_id', 'title', 'channel', 'duration_seconds',
          'published_at', 'views', 'url', 'relevance_proxy', 'topic_distance_proxy', 'personal_novelty',
          'quality', 'selection_score', 'rationale', 'discovery_source', 'origins'], selected.map(v => ({ ...v,
          discovery_source: report.discovery_source, origins: JSON.stringify(v.origins) }))),
      };
      for (const [name, contents] of Object.entries(outputs)) {
        await writeFile(new URL(path + name, root), contents, { flag: 'wx' });
        report.output_sha256[path + name] = hash(contents);
      }
      report.eligible_counts = rankings.eligible_counts;
      report.selected_counts = Object.fromEntries(streams.map(s => [s, rankings.diversified[s].length]));
      report.cross_stream_duplicates = selected.length - new Set(selected.map(v => v.video_id)).size;
      report.baseline_overlap = Object.fromEntries(streams.map(s => [s,
        rankings.diversified[s].filter(v => rankings.search_baseline[s].some(b => b.video_id === v.video_id)).length]));
      report.status = mode === '--cached' ? 'CACHED_REHEARSAL_COMPLETE' : 'STREAM_CANDIDATES_COLLECTED';
    }
  } catch (error) {
    report.failure_code = error instanceof SafeError ? error.message : 'LOCAL_PROCESSING_ERROR';
    process.exitCode = 1;
  } finally {
    key = undefined;
    report.request_counts = { search: report.requests.filter(r => r.endpoint === 'search').length,
      metadata: report.requests.filter(r => r.endpoint === 'videos').length };
    report.provider_quota_meter_verified = false;
    await mkdir(new URL('results/', root), { recursive: true });
    const path = `results/b11-run-${id}.json`;
    await writeFile(new URL(path, root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, failure_code: report.failure_code,
      eligible_counts: report.eligible_counts, selected_counts: report.selected_counts,
      cross_stream_duplicates: report.cross_stream_duplicates, request_counts: report.request_counts,
      inference_requests: 0, quality_assessed: false, evidence: path }, null, 2));
    console.log('Technical evidence only. No recommendation-quality or personal-novelty verdict.');
  }
}
