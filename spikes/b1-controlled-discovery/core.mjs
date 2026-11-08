import { collect, SafeError, validId, validatePlan } from '../b1-youtube-candidates/core.mjs';

export const streams = ['direct', 'adjacent', 'wildcard'];
const fail = code => { throw new SafeError(code); };
const tokens = text => new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
const overlap = (a, b) => {
  const common = [...a].filter(t => b.has(t)).length;
  return common / (a.size + b.size - common || 1);
};
const round = n => Math.round(n * 10000) / 10000;

export function validateExperiment(plan) {
  validatePlan(plan);
  if (plan.experiment !== 'B1.1' || plan.intents.some((s, i) => s.id !== streams[i])
    || new Set(plan.intents.flatMap(s => s.queries)).size !== 12) fail('INVALID_STREAM_PLAN');
  for (const s of plan.intents) {
    for (const name of ['terms', 'bridge_terms', 'exploration_terms']) {
      if (!Array.isArray(s[name]) || s[name].length < 1 || s[name].length > 20
        || s[name].some(t => typeof t !== 'string' || !/^[a-z]+$/.test(t))
        || new Set(s[name]).size !== s[name].length) fail('INVALID_STREAM_PLAN');
    }
    if (s.min_minutes !== 20 || s.max_minutes !== 120) fail('INVALID_STREAM_PLAN');
  }
  return plan;
}

// Reuse B1's bounded collector, credential handling and metadata sanitizer unchanged.
export async function collectExperiment(plan, request) {
  validateExperiment(plan);
  const views = new Map();
  const data = await collect(plan, async (endpoint, params) => {
    const items = await request(endpoint, endpoint === 'videos'
      ? { ...params, part: 'snippet,contentDetails,statistics' } : params);
    if (endpoint === 'videos') for (const item of items) {
      const value = item?.statistics?.viewCount;
      views.set(item?.id, typeof value === 'string' && /^\d{1,16}$/.test(value)
        && Number.isSafeInteger(Number(value)) ? Number(value) : null);
    }
    return items;
  });
  data.candidates = data.candidates.map(v => ({ ...v, views: views.get(v.video_id) ?? null }));
  return data;
}

function scoreCandidate(spec, v, directTerms) {
  if (!validId(v?.video_id) || typeof v.title !== 'string' || v.title.length > 500
    || typeof v.description !== 'string' || v.description.length > 6000
    || typeof v.channel !== 'string' || v.channel.length > 500
    || !Number.isInteger(v.best_search_rank) || v.best_search_rank < 1 || v.best_search_rank > 25
    || !Number.isInteger(v.first_query_index) || v.first_query_index < 0 || v.first_query_index > 3) {
    fail('INVALID_CANDIDATE');
  }
  if (!Number.isFinite(v.duration_seconds) || v.duration_seconds < spec.min_minutes * 60
    || v.duration_seconds > spec.max_minutes * 60 || v.live_status !== 'none') return null;
  const words = tokens(`${v.title} ${v.description}`);
  const titleWords = tokens(v.title);
  const matched = name => spec[name].filter(t => words.has(t));
  const domain = matched('terms'), bridge = matched('bridge_terms'), exploration = matched('exploration_terms');
  const titleDomain = spec.terms.filter(t => titleWords.has(t));
  const titleBridge = spec.bridge_terms.filter(t => titleWords.has(t));
  // Relevance guardrail, NOT a validated depth/credibility or quality threshold.
  if (!domain.length || !bridge.length) return null;
  // Channel boilerplate can mention unrelated topics. Require title support; accept lower recall.
  if (spec.id === 'adjacent' ? !titleDomain.length && !titleBridge.length : !titleDomain.length) return null;
  const domainScore = Math.min(domain.length / 3, 1), bridgeScore = Math.min(bridge.length / 3, 1);
  const explorationScore = Math.min(exploration.length / 2, 1);
  const directOverlap = [...directTerms].filter(t => words.has(t)).length;
  const distance = 1 - Math.min(directOverlap / 3, 1);
  const relevance = spec.id === 'direct' ? 0.65 * domainScore + 0.35 * bridgeScore
    : 0.4 * domainScore + 0.6 * bridgeScore;
  const objective = spec.id === 'direct' ? relevance : spec.id === 'adjacent'
    ? 0.85 * relevance + 0.15 * distance
    : 0.6 * relevance + 0.2 * explorationScore + 0.2 * distance;
  return { video: v, words, domain, bridge, exploration, titleDomain, titleBridge, relevance, distance, objective };
}

function allocate(pools, method, count) {
  const result = Object.fromEntries(streams.map(s => [s, []]));
  const selected = [], used = new Set();
  // Round-robin limits starvation. Fixed DIRECT-first tie priority is deliberate and reported.
  for (let slot = 0; slot < count; slot++) for (const stream of streams) {
    const scored = pools[stream].filter(v => !used.has(v.video.video_id)).map(v => {
      const redundancy = Math.max(0, ...selected.map(s => overlap(s.words, v.words)));
      // Channel names are only a proxy until channel IDs are in this experiment's schema.
      const sameChannel = v.video.channel.trim() && selected.some(s =>
        s.video.channel.trim().toLowerCase() === v.video.channel.trim().toLowerCase());
      const penalty = (stream === 'direct' ? 0.1 : stream === 'adjacent' ? 0.2 : 0.3) * redundancy
        + (sameChannel ? 0.1 : 0);
      return { ...v, selection_score: method === 'search_baseline' ? null : v.objective - penalty };
    });
    scored.sort((a, b) => (method === 'search_baseline' ? 0 : b.selection_score - a.selection_score)
      || a.video.best_search_rank - b.video.best_search_rank
      || a.video.first_query_index - b.video.first_query_index
      || (a.video.video_id < b.video.video_id ? -1 : a.video.video_id > b.video.video_id ? 1 : 0));
    const winner = scored[0];
    if (!winner) continue;
    used.add(winner.video.video_id);
    selected.push(winner);
    const v = winner.video;
    result[stream].push({
      stream, rank: result[stream].length + 1, video_id: v.video_id, title: v.title, channel: v.channel,
      duration_seconds: v.duration_seconds, published_at: v.published_at, views: v.views ?? null,
      url: `https://www.youtube.com/watch?v=${v.video_id}`, origins: v.origins,
      relevance_proxy: round(winner.relevance), topic_distance_proxy: round(winner.distance),
      personal_novelty: null, quality: 'UNASSESSED',
      selection_score: winner.selection_score === null ? null : round(winner.selection_score),
      signals: { domain_terms: winner.domain, bridge_terms: winner.bridge, exploration_terms: winner.exploration,
        title_domain_terms: winner.titleDomain, title_bridge_terms: winner.titleBridge },
      rationale: `${stream.toUpperCase()}: title support [${[...winner.titleDomain, ...winner.titleBridge].join(', ')}]; title/description domain terms [${winner.domain.join(', ')}]; shared-interest terms [${winner.bridge.join(', ')}]. Metadata-based hypothesis; content quality and personal novelty are unknown.`,
    });
  }
  return result;
}

export function rankExperiment(plan, candidates, count = 10) {
  validateExperiment(plan);
  if (!Array.isArray(candidates) || candidates.length > 900 || !Number.isInteger(count)
    || count < 1 || count > 10) fail('INVALID_RANKING_INPUT');
  const keys = new Set();
  for (const v of candidates) {
    if (!streams.includes(v?.intent) || keys.has(`${v.intent}:${v.video_id}`)) fail('INVALID_CANDIDATE_MEMBERSHIP');
    keys.add(`${v.intent}:${v.video_id}`);
  }
  const directTerms = new Set(plan.intents[0].terms);
  const pools = Object.fromEntries(plan.intents.map(s => [s.id,
    candidates.filter(v => v.intent === s.id).map(v => scoreCandidate(s, v, directTerms)).filter(Boolean)]));
  return {
    algorithm: 'lexical-stream-objectives-v1', semantic_model_used: false,
    allocation_order: streams, quality_verdict: null,
    eligible_counts: Object.fromEntries(streams.map(s => [s, pools[s].length])),
    search_baseline: allocate(pools, 'search_baseline', count),
    diversified: allocate(pools, 'diversified', count),
  };
}
