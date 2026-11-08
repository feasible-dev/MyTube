import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { videoUrl } from './model.mjs';
import { loadCatalog } from './catalog.mjs';

// Optional build-time public-image fetch, never used by the delivered page.
const root = new URL('../', import.meta.url);
const run = '1794082922012-ec99cd17-1777-42bf-8ccb-343a44c6ed85';
const report = JSON.parse(await readFile(new URL(`results/b11-run-${run}.json`, root), 'utf8'));
const path = `results/b11/${run}/rankings.json`;
const bytes = await readFile(new URL(path, root));
assert.equal(createHash('sha256').update(bytes).digest('hex'), report.output_sha256[path]);
const rankings = JSON.parse(bytes);
const catalog = await loadCatalog();
const ids = [...new Set([...catalog.videos.map(v => v.video_id), ...['diversified', 'search_baseline'].flatMap(m => Object.values(rankings[m]).flat().map(v => v.video_id))])];
assert.ok(ids.length <= 600);
await mkdir(new URL('poc/thumbnails/', root), { recursive: true });
let cached = 0, downloaded = 0, failed = 0;
for (const id of ids) {
  videoUrl(id);
  const target = new URL(`poc/thumbnails/${id}.jpg`, root);
  try { await readFile(target); cached++; continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let reader, response;
  try {
    response = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok || !/^image\/jpeg(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error('INVALID_IMAGE');
    reader = response.body.getReader(); const chunks = []; let length = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > 300000) throw new Error('IMAGE_TOO_LARGE'); chunks.push(value);
    }
    const jpg = Buffer.concat(chunks);
    assert.ok(jpg[0] === 255 && jpg[1] === 216 && jpg[2] === 255);
    await writeFile(target, jpg, { flag: 'wx' }); downloaded++;
  } catch { failed++; }
  finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response?.body?.cancel().catch(() => {});
  }
}
console.log(JSON.stringify({ public_images_only: true, api_keys_used: false, cached, downloaded, failed }));
