// Pure calculation only. Synthetic results are never evidence of real user preferences.
const fields = ['relevant', 'want_to_watch', 'already_known', 'perceived_quality', 'short'];
const methods = ['search_baseline', 'keyword_baseline'];
const fail = code => { throw new Error(code); };

export function assess(lists, ratings, dataKind) {
  if (!['SYNTHETIC_ONLY', 'HUMAN_PROVIDED'].includes(dataKind)) fail('DATA_KIND_REQUIRED');
  if (!Array.isArray(lists) || !Array.isArray(ratings)) fail('INVALID_INPUT');
  const groups = new Map(), allowed = new Set();
  for (const list of lists) {
    if (typeof list.intent !== 'string' || !/^[a-z_]+$/.test(list.intent)
      || !methods.includes(list.method) || !Array.isArray(list.item_ids) || list.item_ids.length > 10
      || list.item_ids.some(id => typeof id !== 'string' || !id)
      || new Set(list.item_ids).size !== list.item_ids.length) fail('INVALID_LIST');
    if (!groups.has(list.intent)) groups.set(list.intent, new Map());
    if (groups.get(list.intent).has(list.method)) fail('DUPLICATE_LIST');
    groups.get(list.intent).set(list.method, list);
    list.item_ids.forEach(id => allowed.add(id));
  }
  for (const group of groups.values()) if (group.size !== 2) fail('MISSING_COMPARISON_LIST');
  const byId = new Map();
  for (const rating of ratings) {
    if (!allowed.has(rating?.item_id) || byId.has(rating.item_id)) fail('UNKNOWN_OR_DUPLICATE_RATING');
    for (const field of fields) {
      const value = rating[field];
      if (value === undefined || value === null || value === '') continue;
      if (!Number.isInteger(value) || value < 0 || value > (field === 'perceived_quality' ? 2 : 1)) fail('INVALID_RATING_VALUE');
    }
    byId.set(rating.item_id, rating);
  }
  const summaries = lists.map(list => {
    const rows = list.item_ids.map(id => byId.get(id) ?? {});
    const metrics = {};
    for (const field of fields) {
      const values = rows.map(row => row[field]).filter(value => Number.isInteger(value));
      metrics[field] = { observed: values.length, missing: rows.length - values.length,
        // Never substitute zero for an unknown judgment or silently change the denominator.
        total: rows.length && values.length === rows.length ? values.reduce((a, b) => a + b, 0) : null };
    }
    const complete = rows.length === 10 && fields.every(field => metrics[field].missing === 0);
    return { intent: list.intent, method: list.method, list_size: rows.length,
      fully_rated_rows: rows.filter(row => fields.every(field => Number.isInteger(row[field]))).length,
      status: rows.length !== 10 ? 'INSUFFICIENT_COVERAGE' : complete ? 'COMPLETE' : 'INCOMPLETE_RATINGS',
      metrics, mean_quality: metrics.perceived_quality.total === null ? null : metrics.perceived_quality.total / rows.length,
      novel_count: metrics.already_known.total === null ? null : rows.length - metrics.already_known.total,
      provisional_thresholds_met: complete ? metrics.relevant.total >= 7
        && metrics.want_to_watch.total >= 5 && metrics.short.total === 0 : null };
  });
  const comparisons = [...groups.keys()].map(intent => {
    const search = summaries.find(s => s.intent === intent && s.method === 'search_baseline');
    const keyword = summaries.find(s => s.intent === intent && s.method === 'keyword_baseline');
    const ready = search.status === 'COMPLETE' && keyword.status === 'COMPLETE';
    return { intent, status: ready ? 'COMPARABLE' : 'NOT_COMPARABLE',
      delta_keyword_minus_search: ready ? {
        relevant: keyword.metrics.relevant.total - search.metrics.relevant.total,
        want_to_watch: keyword.metrics.want_to_watch.total - search.metrics.want_to_watch.total,
        mean_quality: keyword.mean_quality - search.mean_quality,
        novel_count: keyword.novel_count - search.novel_count,
        short: keyword.metrics.short.total - search.metrics.short.total,
      } : null };
  });
  return { data_kind: dataKind, product_verdict: null,
    quality_evidence: dataKind === 'SYNTHETIC_ONLY' ? 'NONE_SYNTHETIC_FIXTURE' : 'USER_SUPPLIED_NOT_INDEPENDENTLY_VERIFIED',
    summaries, comparisons };
}
