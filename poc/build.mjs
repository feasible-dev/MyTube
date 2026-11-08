import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { escapeEmbeddedJson, STREAMS, videoUrl } from './model.mjs';
import { buildPageAssets } from '../scripts/page-assets.mjs';
import { loadCatalog } from './catalog.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root));
const json = async path => JSON.parse((await read(path)).toString('utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = '1794082922012-ec99cd17-1777-42bf-8ccb-343a44c6ed85';
const report = await json(`results/b11-run-${run}.json`);
const path = `results/b11/${run}/rankings.json`;
const bytes = await read(path);
assert.equal(hash(bytes), report.output_sha256[path], 'Ranking source changed');
const rankings = JSON.parse(bytes);
for (const method of ['diversified', 'search_baseline']) {
  const ids = new Set();
  for (const s of STREAMS) for (const v of rankings[method][s]) {
    videoUrl(v.video_id);
    assert.ok(!ids.has(v.video_id)); ids.add(v.video_id);
    assert.ok(typeof v.title === 'string' && v.title.length <= 500);
    assert.ok(typeof v.channel === 'string' && v.channel.length <= 500);
    assert.ok(v.duration_seconds >= 1200 && v.duration_seconds <= 7200);
  }
}
const aiReport = await json('results/a3-chatgpt-run-1794084228789-07824c19-a90b-4c29-9c41-ceffb403138d.json');
const aiPath = '.private/a3-chatgpt/1794084228787-33b32170-5ec5-4472-8e4c-2c8851da57a8/query-plan.json';
const aiBytes = await read(aiPath);
assert.equal(hash(aiBytes), aiReport.output_sha256[aiPath], 'AI source changed');
const images = {};
const catalog = await loadCatalog();
for (const id of new Set([...catalog.videos.map(v => v.video_id), ...['diversified', 'search_baseline'].flatMap(m => Object.values(rankings[m]).flat().map(v => v.video_id))])) {
  try {
    const image = await read(`poc/thumbnails/${id}.jpg`);
    assert.ok(image.length <= 300000 && image[0] === 255 && image[1] === 216 && image[2] === 255);
    images[id] = `data:image/jpeg;base64,${image.toString('base64')}`;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const { version } = await json('package.json');
assert.match(version, /^\d+\.\d+\.\d+$/, 'Preview version must be a browser-compatible release number');
const snapshot = { preview_version: version, collected_at: report.recorded_at, expires_at: catalog.expiresAt, catalog: catalog.videos,
  rankings: { diversified: rankings.diversified, search_baseline: rankings.search_baseline },
  ai: JSON.parse(aiBytes).generated, images };
const { code, css } = await buildPageAssets(snapshot);
const cspHash = value => createHash('sha256').update(value).digest('base64');
const csp = `default-src 'none'; script-src 'sha256-${cspHash(code)}'; style-src 'sha256-${cspHash(css)}'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
let html = (await read('poc/template.html')).toString('utf8');
html = html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace('<!--STYLE-->', `<style>${css}</style>`).replace('<!--APP-->', `<script>${code}</script>`);
await writeFile(new URL('poc/index.html', root), html);
await mkdir(new URL('results/', root), { recursive: true });
await writeFile(new URL('results/poc-build.json', root), JSON.stringify({ status: 'BUILT',
  built_at: new Date().toISOString(), source_b11_run: run, source_rankings_sha256: hash(bytes),
  source_ai_plan_sha256: hash(aiBytes), embedded_thumbnails: Object.keys(images).length,
  catalog_videos: catalog.videos.length, catalog_source_sha256: catalog.hashes,
  automatic_network_requests: 0, runtime_ai_calls: 0, artifact: 'poc/index.html',
  artifact_sha256: hash(html), artifact_bytes: Buffer.byteLength(html), public_distribution_approved: false }, null, 2) + '\n');
console.log(`Built poc/index.html (${Math.round(Buffer.byteLength(html) / 1024)} KiB, ${Object.keys(images).length} embedded thumbnails). No runtime network access.`);

// Reuse the same validated assets for the extension; never bundle by directory copy.
export { code, css, snapshot };
