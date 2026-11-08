import { defaultPreferences, validatePreferences, PREFERENCE_AXES, LANGUAGE_CHOICES } from '../extension/preferences.mjs';

// Storage schema is independent of the extension release and search-history cache.
export const VIEWING_PREFERENCES_KEY = 'mytube.viewing-preferences';
function migrateViewingPreferences(value) {
  const result = defaultPreferences();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const axis of PREFERENCE_AXES) {
    if (Number.isInteger(value[axis]) && value[axis] >= 0 && value[axis] <= 100) result[axis] = value[axis];
  }
  for (const bound of ['minMinutes', 'maxMinutes']) {
    if (Number.isInteger(value[bound]) && value[bound] >= 1 && value[bound] <= 360) result[bound] = value[bound];
  }
  if (result.minMinutes > result.maxMinutes) {
    result.minMinutes = defaultPreferences().minMinutes; result.maxMinutes = defaultPreferences().maxMinutes;
  }
  if (Array.isArray(value.languages)) {
    const languages = [...new Set(value.languages)].filter(code => LANGUAGE_CHOICES.some(language => language.code === code));
    if (languages.length) result.languages = languages;
  }
  return validatePreferences(result);
}
export function saveViewingPreferences(storage, value) {
  try { storage?.setItem(VIEWING_PREFERENCES_KEY, JSON.stringify({ version: 1, values: validatePreferences(value) })); }
  catch { /* Unavailable storage must not prevent adjusting preferences. */ }
}
export function loadViewingPreferences(storage, previousSearchPreferences) {
  try {
    const raw = storage?.getItem(VIEWING_PREFERENCES_KEY);
    if (raw == null) {
      const migrated = migrateViewingPreferences(previousSearchPreferences);
      if (previousSearchPreferences) saveViewingPreferences(storage, migrated);
      return migrated;
    }
    if (raw.length > 16384) return defaultPreferences();
    const record = JSON.parse(raw);
    // An unknown major schema is not rewritten just by opening an older app.
    return record?.version === 1 ? migrateViewingPreferences(record.values) : defaultPreferences();
  } catch { return defaultPreferences(); }
}
