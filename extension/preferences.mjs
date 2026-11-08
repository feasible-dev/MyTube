// Only non-secret, explicitly chosen viewing preferences cross this boundary.
export const LANGUAGE_CHOICES = [
  ['en', 'English'], ['fr', 'French'], ['es', 'Spanish'], ['zh-Hans', 'Chinese (simplified)'],
  ['hi', 'Hindi'], ['ar', 'Arabic'], ['pt', 'Portuguese'], ['bn', 'Bengali'], ['ru', 'Russian'],
  ['ur', 'Urdu'], ['id', 'Indonesian'], ['de', 'German'], ['ja', 'Japanese'], ['tr', 'Turkish'], ['vi', 'Vietnamese'],
  ['it', 'Italian'], ['ko', 'Korean'], ['zh-Hant', 'Chinese (traditional)'], ['fa', 'Persian'],
  ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['pa', 'Punjabi'], ['sw', 'Swahili'],
  ['th', 'Thai'], ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['he', 'Hebrew'],
  ['el', 'Greek'], ['sv', 'Swedish'], ['ro', 'Romanian'], ['hu', 'Hungarian'], ['cs', 'Czech'],
  ['fi', 'Finnish'], ['da', 'Danish'], ['no', 'Norwegian'], ['tl', 'Filipino / Tagalog'], ['ms', 'Malay'],
].map(([code, name]) => Object.freeze({ code, name }));
export const PREFERENCE_AXES = Object.freeze(['origin', 'audience', 'depth', 'perspective', 'politics', 'recency', 'popularity', 'originality']);
export const EDITORIAL_LEVELS = Object.freeze({
  origin: ['YouTube', 'Mostly YouTube', 'Mixed', 'Mostly recordings', 'Recordings'],
  audience: ['Masculine', 'Mostly masculine', 'Mixed', 'Mostly feminine', 'Feminine'],
  depth: ['Easy viewing', 'Accessible', 'Balanced', 'In-depth', 'Specialist'],
  recency: ['Older', 'Mostly older', 'Mixed', 'Mostly recent', 'Recent'],
  popularity: ['Less seen', 'Mostly less seen', 'Mixed', 'Mostly popular', 'Popular'],
  originality: ['Nearby', 'Mostly nearby', 'Balanced', 'Adventurous', 'Wildcards'],
  politics: ['Left', 'Center-left', 'Center', 'Center-right', 'Right'],
  perspective: ['Mainstream', 'Mostly mainstream', 'Balanced', 'Mostly alternative', 'Alternative'],
});
export function editorialLevel(axis, value) {
  const index = Math.max(0, Math.min(4, Math.round(value / 25)));
  return { value: index * 25, number: index + 1, label: EDITORIAL_LEVELS[axis][index] };
}
export function editorialInstructions(preferences) {
  const p = editorialLevel('politics', preferences.politics), s = editorialLevel('perspective', preferences.perspective);
  return `Use exactly FIVE editorial levels. Politics: 1 Left, 2 Center-left, 3 Center (no preferred side), 4 Center-right, 5 Right. Selected: ${p.number} — ${p.label}. Viewpoint: 1 Mainstream, 2 Mostly mainstream, 3 Balanced, 4 Mostly alternative, 5 Alternative. Selected: ${s.number} — ${s.label}. Apply these choices when choosing search angles, sources and recommendations; politics only when relevant to the subject. The intermediate positions are moderate preferences, not percentages or claims about a creator's politics. Explicit wording in the viewing request takes precedence. Source popularity and platform are not proof of political orientation or reliability. Learning about a subject does not mean debunking it. Seek primary sources and substantive sympathetic explanations, not only critics or scandals. Apply this across viewpoints. Honor the selected perspective; at Center seek varied treatments. Never invent viewpoint labels or treat sympathy as proof.`;
}
export function defaultPreferences() {
  return { origin: 50, audience: 50, depth: 50, perspective: 50, politics: 50, recency: 50, popularity: 50, originality: 50, minMinutes: 20, maxMinutes: 120, languages: ['en'] };
}
export function validatePreferences(value = defaultPreferences()) {
  const reject = () => { throw new Error('INVALID_PREFERENCES'); };
  // Existing on-device preferences predate the originality axis.
  if (value && !Array.isArray(value) && typeof value === 'object' && !Object.hasOwn(value, 'originality')) value = { ...value, originality: 50 };
  const keys = [...PREFERENCE_AXES, 'minMinutes', 'maxMinutes', 'languages'];
  if (!value || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) reject();
  if (!PREFERENCE_AXES.every(k => Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 100)) reject();
  if (!Number.isInteger(value.minMinutes) || !Number.isInteger(value.maxMinutes)
    || value.minMinutes < 1 || value.maxMinutes > 360 || value.minMinutes > value.maxMinutes) reject();
  if (!Array.isArray(value.languages) || !value.languages.length || value.languages.length > LANGUAGE_CHOICES.length
    || new Set(value.languages).size !== value.languages.length
    || !value.languages.every(code => LANGUAGE_CHOICES.some(language => language.code === code))) reject();
  return { ...value, ...Object.fromEntries(PREFERENCE_AXES.map(axis => [axis, editorialLevel(axis, value[axis]).value])), languages: [...value.languages] };
}
export function languageMatches(audioLanguage, selected) {
  if (!audioLanguage) return true; // Missing metadata is not evidence of a different language.
  const base = audioLanguage.toLowerCase().split('-')[0];
  return selected.some(code => code.toLowerCase().split('-')[0] === base);
}
