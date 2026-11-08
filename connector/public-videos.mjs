import { Failure } from '../spikes/a1-openai-login/protocol.mjs';

// Public oEmbed metadata: no Google account, API key, cookies or search.list call.
// Only IDs already grounded in web-search sources reach this boundary.
export async function publicVideoMetadata(picks, signal, fetchImpl = fetch) {
  if (!Array.isArray(picks) || picks.length > 60 || picks.some(p => !/^[A-Za-z0-9_-]{11}$/.test(p?.video_id ?? ''))) throw new Failure('INVALID_GENERATED_RESPONSE');
  const rows = new Array(picks.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, picks.length) }, async () => {
    while (cursor < picks.length && !signal?.aborted) {
      const index = cursor++, p = picks[index]; let reader;
      const url = new URL('https://www.youtube.com/oembed');
      url.search = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${p.video_id}`, format: 'json' });
      try {
        const r = await fetchImpl(url.href, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/json' }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]) });
        if (!r.ok || !r.body || !/^application\/json(?:;|$)/i.test(r.headers.get('content-type') ?? '')) { await r.body?.cancel(); continue; }
        reader = r.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let body = '', bytes = 0;
        while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 65536) throw Error(); body += decoder.decode(value, { stream: true }); }
        const value = JSON.parse(body + decoder.decode());
        if (value?.provider_name !== 'YouTube' || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500
          || typeof value.author_name !== 'string' || !value.author_name.trim() || value.author_name.length > 500) continue;
        let channelUrl;
        try { const author = new URL(value.author_url);
          if (author.protocol === 'https:' && ['youtube.com', 'www.youtube.com'].includes(author.hostname) && !author.username && !author.password && !author.port
            && /^\/(?:channel\/UC[A-Za-z0-9_-]{22}|@[^/\s]{1,100})\/?$/u.test(author.pathname)) channelUrl = `https://www.youtube.com${author.pathname.replace(/\/$/, '')}`;
        } catch { /* Some oEmbed responses omit the creator URL. */ }
        rows[index] = { video_id: p.video_id, title: value.title, channel: value.author_name, description: '',
          ...(channelUrl ? { channel_url: channelUrl } : {}),
          duration_seconds: null, published_at: null, views: null, source: 'youtube_web',
          discovery_stream: p.stream, discovery_why: p.why,
          source_url: `https://www.youtube.com/watch?v=${p.video_id}` };
      } catch { /* A removed/private/unavailable video is omitted, never invented. */ }
      finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
    }
  }));
  if (signal?.aborted) throw new Failure('CANCELLED');
  return rows.filter(Boolean);
}
