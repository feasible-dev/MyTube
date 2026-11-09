// Manual real-browser smoke test: isolated profile, synthetic connector only.
// Never opens the user's Firefox profile or reads provider credentials.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startConnector } from '../connector/server.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';
import { parseHTML } from 'linkedom';
import { renderVideoCard } from '../poc/video-card.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'results'), { recursive: true });
await writeFile(join(root, 'results/firefox-smoke.json'), JSON.stringify({ passed: false, status: 'RUNNING' }));
const work = await mkdtemp(join(root, '.mytube-firefox-smoke-'));
const profile = join(work, 'profile'), extension = join(work, 'extension');
await mkdir(profile); await mkdir(extension);
// The UUID belongs only to this test profile. All provider methods are injected.
const uuid = '12345678-1234-4123-8123-123456789abc';
const origin = `moz-extension://${uuid}`;
await writeFile(join(profile, 'user.js'), [
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'mytube-local-preview@mytube.invalid': uuid }))});`,
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
].join('\n'));
const connector = await startConnector({ port: 0, extensionId: origin,
  signOut: async () => {}, connect: async () => {}, planner: async () => { throw Error('NO_REAL_PROVIDER'); },
  youtube: { configured: async () => true, setup: async () => ({ opened: false }), durations: async () => [],
    search: async () => ({ requests: 1, search_results: 1, videos: [{ video_id: 'abcdefghijk', title: 'Space engineering', channel: 'Synthetic fixture',
      source: 'youtube_live', duration_seconds: 1800, published_at: '2026-11-01T00:00:00Z', view_count: 1000 }] }) } });
const evidence = JSON.parse(await readFile(join(root, 'results/extension-build.json'), 'utf8'));
for (const name of Object.keys(evidence.targets.firefox.files_sha256)) {
  const source = join(root, 'dist/firefox', name), destination = join(extension, name);
  if (/\.(json|js|html)$/.test(name)) await writeFile(destination, (await readFile(source, 'utf8')).replaceAll('127.0.0.1:43817', `127.0.0.1:${connector.port}`));
  else await copyFile(source, destination);
}
const childEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
childEnv.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';
const child = spawn('C:\\Program Files\\Mozilla Firefox\\firefox.exe', ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'], { env: childEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let ws, sequence = 0;
const pending = new Map();
try {
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Firefox debugging startup timed out')), 20000);
    child.on('error', reject);
    child.stderr.on('data', bytes => {
      const match = /WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(bytes.toString());
      if (match) { clearTimeout(timer); resolve(match[1] + '/session'); }
    });
  });
  ws = new WebSocket(address);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const value = JSON.parse(data), job = pending.get(value.id);
    if (!job) return;
    pending.delete(value.id); clearTimeout(job.timer);
    if (value.type === 'error') job.reject(Error(value.error + ': ' + value.message)); else job.resolve(value.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('BiDi timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const session = await send('session.new', { capabilities: {} });
  await send('webExtension.install', { extensionData: { type: 'path', path: extension } });
  const { context } = await send('browsingContext.create', { type: 'tab' });
  await send('browsingContext.navigate', { context, url: origin + '/welcome.html', wait: 'complete' });
  const evaluate = async expression => {
    const result = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw Error('Browser script failed: ' + result.exceptionDetails.text);
    return result.result.value;
  };
  assert.equal(await evaluate('document.getElementById("extension-id").textContent'), origin);
  assert.equal(await evaluate('document.getElementById("browser-choice").value'), 'firefox');
  assert.equal(await evaluate('document.getElementById("mytube-address").value'), origin + '/index.html');
  assert.equal(await evaluate('document.getElementById("pin-instructions").textContent.includes("Pin to Toolbar")'), true);
  const welcomeScreenshot = await send('browsingContext.captureScreenshot', { context });
  await writeFile(join(root, 'results/firefox-welcome.png'), Buffer.from(welcomeScreenshot.data, 'base64'));
  // Exercise real Firefox fetch/Origin/CSP, not a Node simulation of headers.
  assert.equal(await evaluate('MyTubeLive.connect(new AbortController().signal).then(() => "connected")'), 'connected');
  assert.equal(await evaluate('document.getElementById("theme-toggle").click(); document.documentElement.dataset.theme'), 'dark');
  await send('browsingContext.navigate', { context, url: origin + '/index.html', wait: 'complete' });
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  assert.equal(await evaluate('MyTubeLive.status().ready'), true);
  // The normal search UI connects on this page before discovery, establishing
  // its in-memory YouTube capability after navigation from the welcome guide.
  assert.equal(await evaluate('MyTubeLive.connect(new AbortController().signal).then(() => "connected")'), 'connected');
  const preparedPlan = { queries: ['direct', 'adjacent', 'wildcard'].map((stream, i) => ({ stream, query: ['space engineering', 'space technology', 'space history'][i], why: 'Synthetic test' })) };
  assert.equal(await evaluate(`MyTubeLive.discover('space engineering', new AbortController().signal, () => {}, () => {}, ${JSON.stringify(defaultPreferences())}, { preparedPlan: ${JSON.stringify(preparedPlan)} }).then(result => result.videos.some(video => video.video_id === 'abcdefghijk'))`), true);
  await evaluate('document.getElementById("theme-toggle").click()');
  const screenshot = await send('browsingContext.captureScreenshot', { context });
  await mkdir(join(root, 'results'), { recursive: true });
  await writeFile(join(root, 'results/firefox-light.png'), Buffer.from(screenshot.data, 'base64'));
  // Measure real rendered cards with different title lengths and absent metadata.
  const fixtureDocument = parseHTML('<html><body></body></html>').document;
  const cards = ['direct', 'adjacent', 'wildcard'].map((stream, index) => {
    const card = renderVideoCard(fixtureDocument, {
      video_id: index === 2 ? 'web:https://vimeo.com/123456789' : 'abcdefghijk',
      title: index ? 'A longer example title that occupies two lines in a video card' : 'Short title',
      channel: 'Example channel', discovery_stream: stream, source: index === 2 ? 'external_web' : 'fixture',
      published_at: '2026-11-01T00:00:00Z', views: 1234, duration_seconds: 1800,
    }, { saved: false, persistent: false, onSave: () => false, onHide() {}, onBan() {} });
    return `<section class="stream ${['direct', 'related', 'wildcard'][index]}">${card.outerHTML}</section>`;
  }).join('');
  const fixtureHtml = `<main><div class="streams two-column-search">${cards}</div></main>`;
  const fixturePath = join(work, 'card-layout.html');
  await writeFile(fixturePath, `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(extension, 'style.css')).href}"></head><body>${fixtureHtml}</body></html>`);
  // Firefox cannot resize privileged extension contexts through BiDi; measure
  // the same packaged CSS and renderer in an isolated ordinary fixture page.
  await send('browsingContext.navigate', { context, url: pathToFileURL(fixturePath).href, wait: 'complete' });
  const cardMeasurements = [];
  for (const width of [1440, 1000, 390]) {
    await send('browsingContext.setViewport', { context, viewport: { width, height: 1000 }, devicePixelRatio: 1 });
    const heights = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll(".video-card")].map(card => Math.round(card.getBoundingClientRect().height)))'));
    assert.equal(new Set(heights).size, 1, `Card heights differ at ${width}px: ${heights}`);
    cardMeasurements.push({ viewport_width: width, heights });
  }
  await send('browsingContext.setViewport', { context, viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 });
  const cardsScreenshot = await send('browsingContext.captureScreenshot', { context });
  await writeFile(join(root, 'results/firefox-card-layout.png'), Buffer.from(cardsScreenshot.data, 'base64'));
  await writeFile(join(root, 'results/firefox-smoke.json'), JSON.stringify({ passed: true, browser: session.capabilities.browserVersion,
    isolated_profile: true, synthetic_connector: true, card_measurements: cardMeasurements,
    provider_login_verified: false, provider_search_verified: false }, null, 2));
  console.log('Firefox smoke passed: installed package, actual loopback connection, synthetic discovery, main page and shared theme persistence. Providers were synthetic.');
  await send('browser.close');
} finally {
  ws?.close(); child.kill(); await connector.close();
  // Leave the isolated profile in the ignored test workspace for diagnostics.
}
