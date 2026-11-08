import { PREFERENCE_AXES, LANGUAGE_CHOICES, editorialLevel, defaultPreferences } from '../extension/preferences.mjs';

// Owns preference controls; the application owns persistence and result rendering.
export function bindPreferenceControls({ document, getPreferences, onChange }) {
  const $ = id => document.getElementById(id);
  function syncPreferences() {
    const viewingPreferences = getPreferences();
    for (const axis of PREFERENCE_AXES) {
      const { value, label } = editorialLevel(axis, viewingPreferences[axis]);
      $('pref-' + axis).value = value;
      $('pref-' + axis).style.setProperty('--position', `${value}%`);
      $('pref-' + axis).title = label;
      $('pref-' + axis).setAttribute('aria-valuetext', label);
    }
    for (const input of document.querySelectorAll('[data-language]')) input.checked = viewingPreferences.languages.includes(input.value);
    $('language-summary').textContent = viewingPreferences.languages.map(code => LANGUAGE_CHOICES.find(l => l.code === code).name).join(', ');
    $('video-language-value').textContent = viewingPreferences.languages.length === 1 ? $('language-summary').textContent : `${viewingPreferences.languages.length} selected`;
    $('languages-button').title = $('language-summary').textContent;
    $('language-note').textContent = viewingPreferences.languages.length > 12 ? 'The first 12 selected languages are targeted per search. All selected languages remain eligible.' : 'Videos with unknown audio language may appear.';
    syncDurationSettings();
  }
  for (const axis of PREFERENCE_AXES) $('pref-' + axis).addEventListener('input', event => {
    const value = Number(event.target.value);
    if (!Number.isInteger(value) || value < 0 || value > 100) return;
    onChange({ ...getPreferences(), [axis]: editorialLevel(axis, value).value }, false); syncPreferences();
  });
  LANGUAGE_CHOICES.forEach((language, index) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = language.code; input.setAttribute('data-language', language.code);
    input.checked = getPreferences().languages.includes(language.code);
    input.addEventListener('change', () => {
      const selected = [...getPreferences().languages].filter(code => code !== language.code);
      if (input.checked) selected.push(language.code);
      if (!selected.length) { input.checked = true; $('language-note').textContent = 'Choose at least one language.'; return; }
      onChange({ ...getPreferences(), languages: selected }, false); syncPreferences();
    });
    label.append(input, document.createTextNode(language.name));
    $(index < 15 ? 'language-options' : 'more-languages').append(label);
  });
  $('reset-preferences').addEventListener('click', () => {
    onChange(defaultPreferences(), true); syncPreferences();
  });
  function syncDurationSettings() {
    const state = getPreferences();
    $('duration-track').style.setProperty('--low', `${(state.minMinutes - 1) / 359 * 100}%`);
    $('duration-track').style.setProperty('--high', `${(state.maxMinutes - 1) / 359 * 100}%`);
    for (const side of ['min', 'max']) {
      const value = state[`${side}Minutes`];
      $(`${side}-duration`).value = value;
      $(`${side}-duration-value`).textContent = `${value} min`;
      $(`${side}-duration`).setAttribute('aria-valuetext', `${value} minutes`);
    }
  }
  for (const side of ['min', 'max']) $(`${side}-duration`).addEventListener('input', event => {
    const value = Number(event.target.value);
    if (!Number.isInteger(value) || value < 1 || value > 360) return;
    const state = { ...getPreferences(), [`${side}Minutes`]: value };
    if (state.minMinutes > state.maxMinutes) state[side === 'min' ? 'maxMinutes' : 'minMinutes'] = value;
    onChange(state, true); syncDurationSettings();
  });
  return { sync: syncPreferences, syncDuration: syncDurationSettings };
}
