import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { videoUrl } from './model.mjs';

export async function loadCatalog() {
  const root = new URL('../', import.meta.url);
  const sources = [
    ['b1', '1794078880207-7c695f76-0cf1-4fcd-9bf2-bb8aa9416367'],
    ['b11', '1794082922012-ec99cd17-1777-42bf-8ccb-343a44c6ed85'],
  ];
  const videos = new Map(), hashes = {}, dates = [];
  for (const [spike, run] of sources) {
    const report = JSON.parse(await readFile(new URL(`results/${spike}-run-${run}.json`, root), 'utf8'));
    const path = `results/${spike}/${run}/candidates.json`;
    const bytes = await readFile(new URL(path, root));
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hashes[path], report.output_sha256[path], 'Catalog evidence changed');
    dates.push(Date.parse(report.recorded_at));
    const rows = JSON.parse(bytes).candidates;
    assert.ok(Array.isArray(rows) && rows.length <= 900);
    for (const v of rows) {
      if (v.live_status !== 'none' || !Number.isFinite(v.duration_seconds)
          || v.duration_seconds < 1200 || v.duration_seconds > 7200) continue;
      videoUrl(v.video_id);
      for (const key of ['title', 'channel']) assert.ok(typeof v[key] === 'string' && v[key].length <= 500);
      assert.ok(typeof v.description === 'string' && v.description.length <= 10000);
      assert.ok(Number.isFinite(Date.parse(v.published_at)));
      videos.set(v.video_id, { video_id: v.video_id, title: v.title, channel: v.channel,
        description: v.description, duration_seconds: v.duration_seconds, published_at: v.published_at,
        views: Number.isSafeInteger(v.views) && v.views >= 0 ? v.views : null });
    }
  }
  assert.ok(videos.size <= 600 && dates.every(Number.isFinite));
  return { videos: [...videos.values()], hashes,
    expiresAt: new Date(Math.min(...dates) + 30 * 86400000).toISOString() };
}
