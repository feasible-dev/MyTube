// Optional metadata enrichment, independent of DOM rendering and persistence.
export function createVideoDurations({ videos = [], load, generation }) {
  const durations = new Map(videos.filter(video => video.duration_source === 'youtube_api')
    .map(video => [video.video_id, video.duration_seconds]));
  const attempted = new Set();
  return {
    get(videoId) { return durations.get(videoId); },
    apply(video) {
      return video.duration_seconds === null && durations.has(video.video_id)
        ? { ...video, duration_seconds: durations.get(video.video_id), duration_source: 'youtube_api' } : video;
    },
    async enrich(candidates) {
      const ids = [...new Set(candidates)]
        .filter(id => /^[A-Za-z0-9_-]{11}$/.test(id) && !attempted.has(id)).slice(0, 50);
      if (!ids.length) return false;
      ids.forEach(id => attempted.add(id));
      const epoch = generation();
      try {
        const rows = await load(ids);
        if (epoch !== generation()) return false;
        let changed = false;
        for (const row of rows) {
          if (ids.includes(row.video_id) && Number.isInteger(row.duration_seconds)
            && row.duration_seconds > 0 && row.duration_seconds <= 21600) {
            durations.set(row.video_id, row.duration_seconds); changed = true;
          }
        }
        return changed;
      } catch { return false; } // Metadata failure must never interrupt discovery.
    },
  };
}
