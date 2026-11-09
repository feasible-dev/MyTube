export const THEME_KEY = 'mytube.color-theme';
const valid = value => value === 'light' || value === 'dark';

export function bindTheme({ document = globalThis.document, events = globalThis, storage } = {}) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { /* Session-only theme. */ }
  }
  let theme = 'light';
  try { const saved = storage?.getItem(THEME_KEY); if (valid(saved)) theme = saved; } catch { /* Use light default. */ }
  const button = document.getElementById('theme-toggle');
  function render(value) {
    theme = value;
    document.documentElement.dataset.theme = theme;
    if (!button) return;
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', 'Dark theme');
    button.setAttribute('aria-checked', String(theme === 'dark'));
    button.title = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
  }
  render(theme);
  button?.addEventListener('click', () => {
    render(theme === 'light' ? 'dark' : 'light');
    try { storage?.setItem(THEME_KEY, theme); } catch { /* Switching still works without storage. */ }
  });
  events.addEventListener?.('storage', event => {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key === THEME_KEY || event.key === null) render(valid(event.newValue) ? event.newValue : 'light');
  });
}
