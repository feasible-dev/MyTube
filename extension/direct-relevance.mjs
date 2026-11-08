// A bounded lexical safeguard, not semantic verification of a video's content.
// Shared with the planner's JSON schema: titles may contain punctuation and accents.
export const PLAN_QUERY_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f<>]{2,150}$';
export const PLAN_SUBJECT_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f<>]{2,80}$';
export const PLAN_EXPLANATION_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f<>]{10,300}$';
export function validPlanText(text, pattern) {
  return typeof text === 'string' && /[\p{L}\p{N}]/u.test(text) && new RegExp(pattern).test(text)
    && !/https?:|www\.|sk-[A-Za-z0-9_-]{16,}/i.test(text);
}
export function normalizeSubject(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function containsSubject(text, subject) {
  const needle = normalizeSubject(subject);
  const haystack = normalizeSubject(text);
  return Boolean(needle && (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(needle) ? haystack.includes(needle) : ` ${haystack} `.includes(` ${needle} `)));
}
export function validDirectSubjects(subjects) {
  return Array.isArray(subjects) && subjects.length >= 1 && subjects.length <= 6
    && subjects.every(s => validPlanText(s, PLAN_SUBJECT_PATTERN));
}
export function matchesDirectSubject(video, query, subjects) {
  // Channel names and promotional footers are not evidence of the subject.
  const metadata = `${video.title ?? ''}\n${String(video.description ?? '').slice(0, 1500)}`;
  if (subjects) return subjects.some(subject => containsSubject(metadata, subject));
  // Compatibility with an older connector: require query topic words, not
  // generic presentation or source words. New plans supply bilingual aliases.
  const generic = new Set('the a an of on in for and or with about full complete video videos documentary documentaries lecture lectures seminar university college history introduction explained explanation analysis'.split(' '));
  const words = [...new Set(normalizeSubject(query).split(' ').filter(w => w.length > 2 && !generic.has(w) && !/^\d+$/.test(w)))];
  return words.length > 0 && words.filter(w => containsSubject(metadata, w)).length >= Math.min(2, words.length);
}
