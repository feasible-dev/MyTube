import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildPageAssets } from '../scripts/page-assets.mjs';
import { buildBrowserScript } from '../scripts/browser-bundle.mjs';
import { readClientId, liveManifestSettings } from './live-config.mjs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const emptyStreams = () => Object.fromEntries(['direct', 'adjacent', 'wildcard'].map(s => [s, []]));
const snapshot = { preview_version: version, catalog: [], images: {},
  rankings: { diversified: emptyStreams(), search_baseline: emptyStreams() },
  ai: { underlying_interests: [], streams: Object.fromEntries(['direct', 'adjacent', 'wildcard'].map(s => [s, { queries: [] }])) } };
const { code, css } = await buildPageAssets(snapshot);
let clientId = null;
try { clientId = readClientId(JSON.parse(await readFile(new URL('./google-client.json', import.meta.url), 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const template = await readFile(new URL('poc/template.html', root), 'utf8');
const liveCode = await buildBrowserScript('extension/live-browser.js');
const background = await readFile(new URL('./background.js', import.meta.url), 'utf8');
const common = {
  manifest_version: 3,
  name: 'MyTube Local Preview',
  version: snapshot.preview_version,
  description: 'Personal YouTube discovery with a local ChatGPT connector. Development preview.',
  action: { default_title: 'Open MyTube' },
};
const evidence = { status: 'BUILT_OFFLINE_CHECKS_PENDING', version: snapshot.preview_version, recorded_at: new Date().toISOString(),
  installation_tested: false, public_distribution_approved: false,
  saved_video_count: Object.values(snapshot.rankings.diversified).flat().length,
  searchable_video_count: snapshot.catalog.length, targets: {} };
const allowed = ['app.js', 'background.js', 'index.html', 'live.js', 'manifest.json', 'style.css'];
for (const target of ['brave', 'firefox']) {
  const dir = new URL(`dist/${target}/`, root);
  await mkdir(dir, { recursive: true });
  // Refuse unexpected leftovers; do not silently ship stale or private files.
  assert.ok((await readdir(dir)).every(name => allowed.includes(name)), 'Unexpected extension output file');
  const { policy, additions } = liveManifestSettings(clientId, target);
  const base = { ...common, ...additions, content_security_policy: { extension_pages: policy } };
  const html = template.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}">`)
    .replace('<!--STYLE-->', '<link rel="stylesheet" href="style.css">')
    .replace('<!--APP-->', '<script src="live.js" defer></script><script src="app.js" defer></script>');
  const manifest = target === 'brave'
    ? { ...base, background: { service_worker: 'background.js' } }
    : { ...base, background: { scripts: ['background.js'] }, browser_specific_settings: {
      gecko: { id: 'mytube-local-preview@mytube.invalid', strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] } } } };
  const assets = { 'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'index.html': html, 'app.js': code, 'live.js': liveCode, 'style.css': css, 'background.js': background };
  const hashes = {};
  for (const [name, data] of Object.entries(assets)) {
    await writeFile(new URL(name, dir), data);
    hashes[name] = createHash('sha256').update(data).digest('hex');
  }
  evidence.targets[target] = { path: `dist/${target}`, files_sha256: hashes,
    permissions: manifest.permissions ?? [], host_permissions: manifest.host_permissions ?? [],
    live_auth_configured: Boolean(manifest.oauth2), live_auth_verified: false };
}
await mkdir(new URL('results/', root), { recursive: true });
await writeFile(new URL('results/extension-build.json', root), JSON.stringify(evidence, null, 2) + '\n');
console.log('Built dist/brave and dist/firefox. Local installation testing remains pending.');
