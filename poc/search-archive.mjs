import { homeVideo } from './home.mjs';
export const ARCHIVE_CLEAR_KEY = 'mytube.history-cleared.v1';

// Search text belongs to the user. Provider metadata is a renewable 30-day cache.
// One record per search, with no rolling count limit. IndexedDB keeps this out of
// the small synchronous localStorage cache. Writes and erasure are serialized.
export function cleanSearch(record, now = Date.now()) {
  if (!record || typeof record.id !== 'string' || typeof record.query !== 'string'
    || !Number.isFinite(record.at) || record.at > now) return null;
  return { id: record.id, at: record.at, query: record.query.slice(0, 6000),
    intention: typeof record.intention === 'string' ? record.intention.slice(0, 6000) : record.query.slice(0, 6000),
    count: Math.max(Number.isSafeInteger(record.count) ? record.count : 0, Array.isArray(record.videos) ? record.videos.length : 0),
    videos: (Array.isArray(record.videos) ? record.videos : []).map(v => homeVideo(v, now)).filter(Boolean) };
}
export function createSearchArchive({ indexedDB = globalThis.indexedDB, storage, onError = () => {} } = {}) {
  const key = 'mytube.search-archive.v1';
  let queue = Promise.resolve(), dbPromise;
  function database() {
    return dbPromise ??= new Promise((resolve, reject) => {
      const open = indexedDB.open('mytube-history', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('searches', { keyPath: 'id' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('HISTORY_UNAVAILABLE'));
      open.onblocked = () => reject(new Error('HISTORY_UNAVAILABLE'));
    });
  }
  const enqueue = work => {
    const next = queue.then(work);
    queue = next.catch(() => { onError(); });
    return queue;
  };
  async function operate(action, record) {
    if (!indexedDB) {
      const rows = JSON.parse(storage?.getItem(key) ?? '[]');
      if (action === 'read') return rows;
      if (!storage) throw new Error('HISTORY_UNAVAILABLE');
      if (action === 'clear') storage.setItem(key, '[]');
      else storage.setItem(key, JSON.stringify([...rows.filter(r => r.id !== record.id), ...(action === 'remove' ? [] : [record])]));
      return;
    }
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('searches', action === 'read' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('searches');
      const request = action === 'read' ? store.getAll() : action === 'clear' ? store.clear() : action === 'remove' ? store.delete(record.id) : store.put(record);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('HISTORY_UNAVAILABLE'));
    });
  }
  return {
    load: () => enqueue(async () => {
      const rows = (await operate('read')).map(r => cleanSearch(r)).filter(Boolean);
      // Persist pruning too, including when no new searches are made.
      for (const row of rows) await operate('put', row);
      return rows.sort((a, b) => b.at - a.at);
    }),
    put: record => enqueue(() => { const clean = cleanSearch(record); if (clean) return operate('put', clean); }),
    remove: id => enqueue(() => operate('remove', { id })),
    clear: () => enqueue(() => operate('clear')),
  };
}

export function archiveRecommendations(records, { hidden = new Set(), saved = new Set(), allowed = () => true, now = Date.now() } = {}) {
  const seen = new Set(hidden), channels = new Map(), result = [];
  const groups = new Map();
  for (const row of records.map(r => cleanSearch(r, now)).filter(Boolean).sort((a, b) => b.at - a.at)) {
    const key = row.intention.normalize('NFKC').trim().toLowerCase();
    const group = groups.get(key) ?? { videos: [], uses: 0, at: row.at };
    group.uses++; group.videos.push(...row.videos); groups.set(key, group);
  }
  const weight = row => row.uses + row.videos.filter(v => saved.has(v.video_id)).length * 3;
  const rows = [...groups.values()].sort((a, b) => weight(b) - weight(a) || b.at - a.at);
  // Interleave interests instead of letting a single large search fill the page.
  const depth = Math.max(0, ...rows.map(r => r.videos.length));
  for (let i = 0; i < depth && result.length < 48; i++) for (const row of rows) {
    const video = row.videos[i];
    if (!video || seen.has(video.video_id) || !allowed(video)) continue;
    const channel = video.channel_id ?? video.channel;
    if ((channels.get(channel) ?? 0) >= 2) continue;
    seen.add(video.video_id); channels.set(channel, (channels.get(channel) ?? 0) + 1);
    result.push(video);
    if (result.length === 48) break;
  }
  return result;
}
