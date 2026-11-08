import { videoReference, prioritizeExternal } from '../extension/video-reference.mjs';
import { publicVideoMetadata } from './public-videos.mjs';
import { externalPreview } from './external-preview.mjs';

// A search citation alone is not proof that an external video still exists.
// Resolve provider previews before publishing; never execute embed HTML.
export function createWildcardProgress({ signal, publish, metadata = publicVideoMetadata, preview = externalPreview }) {
  const rows = new Map(), pool = new Map(), pending = new Map(); let closed = false, searches = 1, searchDetails = [];
  const group = v => ['BitChute', 'Rumble', 'Rutube', 'Odysee', 'Internet Archive'].includes(v.platform) ? 'alternative' : 'general';
  const emit = () => publish({ type: 'progress', videos: [...rows.values()], searches, search_details: searchDetails });
  function select(video, reserve = true) {
    if (rows.has(video.video_id) || rows.size >= 8) return;
    const previous = [...rows.values()], platform = video.platform ?? 'YouTube';
    // Leave space for the other independent search while it is still working.
    if (reserve && previous.filter(v => group(v) === group(video)).length >= 5) return;
    if (previous.filter(v => (v.platform ?? 'YouTube') === platform).length >= (platform === 'YouTube' ? 8 : 3)) return;
    if (!video.channel_unknown && previous.filter(v => v.channel === video.channel).length >= 2) return;
    if (previous.some(v => v.title.trim().toLowerCase() === video.title.trim().toLowerCase())) return;
    rows.set(video.video_id, video);
  }
  async function load(pick) {
    const ref = videoReference(pick.source_url);
    if (!ref || ref.video_id !== pick.video_id) return null;
    if (ref.platform === 'YouTube') return (await metadata([pick], signal))[0] ?? null;
    if (typeof pick.title !== 'string' || !pick.title.trim() || pick.title.length > 500) return null;
    return { video_id: ref.video_id, source_url: ref.url, platform: ref.platform, title: pick.title,
      channel: ref.platform, channel_unknown: true, source: 'external_web', description: '',
      duration_seconds: null, published_at: null, views: null, discovery_stream: 'wildcard', discovery_why: pick.why };
  }
  function enqueue(pick) {
    if (closed || pending.size >= 32 || pending.has(pick.video_id)) return;
    pending.set(pick.video_id, load(pick).then(async video => {
      if (!closed && !signal.aborted && video) {
        if (video.source === 'external_web') {
          const image = await preview(video, signal);
          if (image.preview_unavailable || !image.thumbnail_url) return;
          Object.assign(video, image);
        }
        if (closed || signal.aborted) return;
        pool.set(video.video_id, video);
        const before = rows.size; select(video); if (rows.size !== before) emit();
      }
    }).catch(() => {}));
  }
  return {
    observe(batch) {
      searches = Math.max(searches, batch.searches ?? 1);
      if (batch.search_details) { searchDetails = batch.search_details.slice(0, 16); emit(); }
      for (const pick of (batch.picks ?? []).slice(0, 16)) enqueue(pick);
    },
    searchDetails() { return searchDetails; },
    async counts() { await Promise.all(pending.values()); return { wildcard: rows.size }; },
    async finish(picks) {
      for (const pick of picks) enqueue(pick); await Promise.all(pending.values());
      // Keep only grounded final selections; a streamed draft may be retracted.
      const finalIds = new Set(picks.map(p => p.video_id));
      rows.clear();
      for (const video of prioritizeExternal([...pool.values()])) if (finalIds.has(video.video_id)) select(video, false);
      return [...rows.values()].filter(v => finalIds.has(v.video_id)).slice(0, 8);
    },
    close() { closed = true; },
  };
}
