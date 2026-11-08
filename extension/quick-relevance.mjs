// Conservative guard for results shown before the planner supplies subject aliases.
// This is lexical evidence, not a semantic assessment of the video.
export function explicitFilmTitle(intention) {
  const query = conciseQuickQuery(intention);
  if (!query) return null;
  // Only an explicit, bounded title request. General topics and translated
  // conversational requests must still be allowed to use provider ranking.
  const match = /^(?:(?:the|le|un|a)\s+)?(?:movie|film)\s+(?:called\s+|intitulé\s+)?["“«]?([^"”»]+?)["”»]?$/iu.exec(query);
  const title = match?.[1].trim();
  return title && title.length <= 80 && title.split(/\s+/).length <= 8
    && !/[,;]|\b(?:about|sur|with|avec|and|et|without|sans)\b/i.test(title) ? title : null;
}

export function conciseQuickQuery(intention) {
  if (typeof intention !== 'string') return null;
  let query = stripViewingIntroduction(intention);
  // A short named topic followed by conversational elaboration is a useful
  // first query. The planner still receives the entire unmodified intention.
  // Preserve explicit exclusions and comma-separated lists of actual subjects.
  if (!/\b(?:sans|without|excluding|avoid|except|pas de)\b/i.test(query)) {
    const topic = query.split(/,\s*(?:toutes? les histoires|tout ce qui|all the stories|everything about)\b/i)[0];
    if (topic !== query && topic.split(/\s+/).length <= 6) query = topic;
  }
  return query.length >= 2 && query.length <= 300 && !/[\x00-\x1f<>]/.test(query) ? query : null;
}
function stripViewingIntroduction(intention) {
  return intention.trim()
    .replace(/^(?:[çc]a me tente|j['’]ai envie)\s+d(?:e\s+|['’])/i, '')
    .replace(/^(?:je suis int[ée]ress[ée]e? (?:par|aux?|à)|je m['’]int[ée]resse (?:aux?|à)|i(?:['’]m| am) interested in)\s+/i, '')
    .replace(/^(?:je (?:voudrais|veux|souhaite|cherche)|j['’]aimerais|i (?:want|would like)(?: to watch| to learn about)?)\s+/i, '')
    .replace(/^(?:(?:en )?apprendre(?: (?:un peu plus|plus|davantage))?|(?:en )?savoir (?:un peu plus|plus|plein de choses)|quelque chose|des (?:vidéos|videos))\s+sur\s+|^something (?:about|on)\s+/i, '')
    .replace(/\s+(?:et|puis)\s+(?:plein de choses apparentées|tout ce qui (?:s['’]y rapporte|est relié)|les choses reliées à ça)[.!?]*$/i, '')
    .replace(/^(?:(?:le|la|les)\s+|l['’])/i, '').replace(/[.!?]+$/, '').trim();
}
// API retrieval can begin with a clearly named lead topic from a long paragraph.
// Keep this separate from cache matching, where a truncated request is not proof
// that an old result meets all of the user's constraints.
export function quickApiQuery(intention) {
  if (typeof intention !== 'string' || /[\x00-\x1f<>]/.test(intention)) return null;
  const full = stripViewingIntroduction(intention), concise = conciseQuickQuery(intention);
  const clauses = full.split(/[,;]\s*/);
  const lead = clauses[0].trim();
  if (clauses.length > 1 && lead.length >= 2 && lead.length <= 90 && lead.split(/\s+/).length <= 8
    && full.split(/\s+/).length > 16 && quickSubjectTerms(lead).length
    && !/\b(?:sans|without|excluding|avoid(?:ing)?|except|pas de)\b/i.test(full)) return lead;
  return concise;
}
function quickWords(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
function quickStem(word) {
  const stem = word.length > 3 ? word.replace(/s$/, '') : word;
  // Small unambiguous spelling variants; broader translation waits for the planner.
  return ({ acore: 'azore', mayan: 'maya' })[stem] ?? stem;
}
const QUICK_GENERIC = new Set(`je j le la les un une des de du aux au et ou en a sur dans avec pour par ce cette ces ca qui que quoi il elle est sont me mon ma mes nous vous voudrais veux aimerais souhaite cherche savoir apprendre entendre voir regarder ecouter quelque chose choses plein beaucoup plus peu tout tous aussi puis general apparente apparentees sujet video videos documentaire documentaires histoire analyse analyses long longs bonne bonnes bon bons i the a an of on in to for and or with about want would like something watch learn hear more know all some things related general video videos documentary documentaries history analysis`.split(' ').map(quickStem));
export function quickSubjectTerms(intention) {
  const query = conciseQuickQuery(intention);
  if (!query) return [];
  // Never reinterpret exclusions as positive search subjects.
  const positive = query.split(/\b(?:sans|without|excluding|avoid(?:ing)?|pas de)\b/i)[0];
  const terms = [...new Set(quickWords(positive).map(quickStem).filter(w => w.length >= 2 && !QUICK_GENERIC.has(w)))];
  return terms.length <= 8 ? terms : [];
}
export function matchesQuickSubject(video, intention) {
  const terms = quickSubjectTerms(intention);
  if (!terms.length) return false;
  // A cache topic label or channel name must never qualify unrelated videos.
  const words = new Set(quickWords(`${video.title ?? ''} ${String(video.description ?? '').slice(0, 300)}`).map(quickStem));
  return terms.every(term => words.has(term));
}
