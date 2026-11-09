export const BROWSER_GUIDES = Object.freeze({
  chrome: { name: 'Chrome', manager: 'chrome://extensions', shortcuts: 'chrome://extensions/shortcuts',
    pin: 'Open the Extensions puzzle-piece menu, find MyTube Local Preview, and click its pin. Click the blue MyTube icon to open it.',
    install: 'Enable Developer mode, choose Load unpacked, and select the project’s dist/brave folder.' },
  edge: { name: 'Microsoft Edge', manager: 'edge://extensions', shortcuts: 'edge://extensions/shortcuts',
    pin: 'Open the Extensions puzzle-piece menu, find MyTube Local Preview, and choose Show in toolbar (the eye icon or the … menu). Click the blue MyTube icon to open it.',
    install: 'Enable Developer mode, choose Load unpacked, and select the project’s dist/brave folder. This package also works with Edge.' },
  brave: { name: 'Brave', manager: 'brave://extensions', shortcuts: 'brave://extensions/shortcuts',
    pin: 'Open the Extensions puzzle-piece menu, find MyTube Local Preview, and click its pin. Click the blue MyTube icon to open it.',
    install: 'Enable Developer mode, choose Load unpacked, and select the project’s dist/brave folder.' },
  firefox: { name: 'Firefox', manager: 'about:debugging#/runtime/this-firefox', shortcuts: 'about:addons',
    pin: 'Open the Extensions puzzle-piece menu, then the gear next to MyTube Local Preview, and choose Pin to Toolbar. Click the blue MyTube icon to open it.',
    install: 'Choose Load Temporary Add-on and select dist/firefox/manifest.json. Allow the requested site permissions. Load it again after Firefox closes; the preview is not signed yet.' },
});

export async function detectBrowser(api, navigator = globalThis.navigator) {
  if (api?.runtime?.getManifest?.()?.browser_specific_settings?.gecko || /Firefox\//.test(navigator?.userAgent ?? '')) return 'firefox';
  if (/Edg\//.test(navigator?.userAgent ?? '')) return 'edge';
  try { if (await navigator?.brave?.isBrave?.()) return 'brave'; } catch { /* Manual selector remains available. */ }
  return 'chrome';
}

export function bindBrowserGuide({ document, api, navigator = globalThis.navigator }) {
  const el = id => document.getElementById(id);
  let selected = false;
  function render(browser) {
    const guide = BROWSER_GUIDES[browser] ?? BROWSER_GUIDES.chrome;
    const steps = browser === 'firefox'
      ? ['Open Extensions (the puzzle icon).', 'Find MyTube Local Preview and click its gear.', 'Choose Pin to Toolbar.']
      : browser === 'edge'
        ? ['Open Extensions (the puzzle icon).', 'Find MyTube Local Preview.', 'Choose Show in toolbar using the eye icon or the … menu.']
        : ['Open Extensions (the puzzle icon).', 'Find MyTube Local Preview.', 'Click its pin to keep MyTube in the toolbar.'];
    el('pin-instructions').replaceChildren(...steps.map(text => {
      const item = document.createElement('li'); item.textContent = text; return item;
    }));
    el('install-instructions').textContent = guide.install;
    el('browser-manager').textContent = guide.manager;
    el('shortcut-settings').textContent = guide.shortcuts;
    el('firefox-reminder').hidden = browser !== 'firefox';
  }
  el('browser-choice').addEventListener('change', () => { selected = true; render(el('browser-choice').value); });
  render('chrome');
  const ready = detectBrowser(api, navigator).then(browser => {
    if (!selected) { el('browser-choice').value = browser; render(browser); }
  });
  return { ready };
}
