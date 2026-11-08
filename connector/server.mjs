import { parseChatGPTRequest } from './chatgpt-requests.mjs';
import { parseYouTubeRequest, executeYouTubeRequest } from './youtube-requests.mjs';
import { readRequestBytes } from './request-body.mjs';
import { PLAN_ERROR_CODES } from '../extension/plan-errors.mjs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { planWithChatGPT, signOutChatGPT, connectChatGPT } from './session.mjs';
import { publicVideoMetadata } from './public-videos.mjs';
import { createWebProgress } from './web-progress.mjs';
import { createWildcardProgress } from './wildcard-progress.mjs';
import { createKeyYouTube, YOUTUBE_PUBLIC_ERRORS } from './youtube-key.mjs';

export const PORT = 43817;
export const EXTENSION_ID = 'fagpjbnjdebnnhdgbkooeclhcbfjjakl';
const safeErrors = new Set(PLAN_ERROR_CODES);

export async function startConnector({ port = PORT, planner = planWithChatGPT, signOut = signOutChatGPT, connect = connectChatGPT, metadata = publicVideoMetadata, preview, youtube = createKeyYouTube(), extensionId = EXTENSION_ID } = {}) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('INVALID_EXTENSION_ID');
  const ORIGIN = `chrome-extension://${extensionId}`;
  let active = null, authorization = null, requestId = null, idle = Promise.resolve(), closing = false;
  const youtubeJobs = new Set();
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Connection', 'close');
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status); res.end(JSON.stringify(value)); } };
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host || req.headers.origin !== ORIGIN) { reply(403, { error: 'FORBIDDEN' }); return; }
    res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Vary', 'Origin');
    if (!['/interpret', '/plan', '/web-discover', '/wildcard-discover', '/connect', '/authorization', '/signout', '/youtube/status', '/youtube/setup', '/youtube/search', '/youtube/durations'].includes(req.url)) { reply(404, { error: 'NOT_FOUND' }); return; }
    if (req.method === 'OPTIONS') {
      const headers = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      const method = 'POST';
      if (req.headers['access-control-request-method'] !== method || headers.some(h => !['content-type', 'x-mytube-protocol', 'x-mytube-request'].includes(h))) { reply(403, { error: 'FORBIDDEN' }); return; }
      res.setHeader('Access-Control-Allow-Methods', method);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MyTube-Protocol, X-MyTube-Request');
      res.writeHead(204); res.end(); return;
    }
    const id = req.headers['x-mytube-request'];
    const validId = typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
    if (req.url.startsWith('/youtube/')) {
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json' || req.headers['x-mytube-protocol'] !== '1' || !validId) { reply(400, { error: 'INVALID_REQUEST' }); return; }
      if (closing || youtubeJobs.size >= 2) { reply(409, { error: 'CONNECTOR_BUSY' }); return; }
      const job = new AbortController(); youtubeJobs.add(job);
      const abortJob = () => { if (!res.writableEnded) job.abort(); }; res.once('close', abortJob);
      const limit = setTimeout(() => job.abort(), 18000);
      try {
        const bytes = await readRequestBytes(req, 4096);
        if (bytes === null) { reply(413, { error: 'INVALID_REQUEST' }); return; }
        let body;
        try { body = JSON.parse(bytes.toString('utf8')); } catch { reply(400, { error: 'INVALID_REQUEST' }); return; }
        const operation = parseYouTubeRequest(req.url, body);
        if (!operation) { reply(400, { error: 'INVALID_REQUEST' }); return; }
        reply(200, await executeYouTubeRequest(operation, youtube, job.signal));
      } catch (error) { reply(400, { error: YOUTUBE_PUBLIC_ERRORS.has(error?.message) ? error.message : 'REQUEST_FAILED' }); }
      finally { clearTimeout(limit); res.off('close', abortJob); youtubeJobs.delete(job); }
      return;
    }
    if (req.url === '/authorization') {
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json' || req.headers['x-mytube-protocol'] !== '1' || !validId) { reply(403, { error: 'FORBIDDEN' }); return; }
      try {
        const bytes = await readRequestBytes(req, 16);
        if (bytes === null) { reply(413, { error: 'INVALID_REQUEST' }); return; }
        const body = JSON.parse(bytes.toString('utf8'));
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) throw Error();
      } catch { reply(400, { error: 'INVALID_REQUEST' }); return; }
      reply(200, { authorization_url: requestId === id ? authorization : null }); return;
    }
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json' || req.headers['x-mytube-protocol'] !== '1') { reply(400, { error: 'INVALID_REQUEST' }); return; }
    if (id !== undefined && !validId) { reply(400, { error: 'INVALID_REQUEST' }); return; }
    if (active || closing) { reply(409, { error: 'CONNECTOR_BUSY' }); return; }
    const controller = new AbortController(); active = controller;
    requestId = id ?? null; let resolveIdle; idle = new Promise(resolve => { resolveIdle = resolve; });
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    const deadline = setTimeout(() => controller.abort(), 330000);
    let webFeed;
    const streamReply = value => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(value) + '\n'); };
    try {
      const bytes = await readRequestBytes(req, 32768);
      if (bytes === null) { reply(413, { error: 'INVALID_INTENTION' }); return; }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const operation = parseChatGPTRequest(req.url, body, validId);
      if (!operation) { reply(400, { error: 'INVALID_REQUEST' }); return; }
      if (operation.type === 'connect') {
        await connect(controller.signal, url => { authorization = url; });
        reply(200, { connected: true }); return;
      }
      if (operation.type === 'signout') {
        await signOut(); reply(200, { signed_out: true }); return;
      }
      const { intention, preferences, recovery, mode } = operation;
      if (controller.signal.aborted) return;
      const wildcard = mode === 'wildcard';
      const streaming = (mode === 'web' || wildcard) && req.headers.accept === 'application/x-ndjson';
      if (streaming) {
        res.setHeader('Content-Type', 'application/x-ndjson'); res.writeHead(200); res.flushHeaders();
      }
      const collectionStop = new AbortController();
      if (wildcard) webFeed = createWildcardProgress({ signal: controller.signal, metadata, preview, publish: streaming ? streamReply : () => {} });
      if (mode === 'web') webFeed = createWebProgress({ intention, signal: controller.signal, metadata, publish: streaming ? streamReply : () => {}, onTarget: () => collectionStop.abort(new Error('COLLECTION_COMPLETE')) });
      const planningSignal = mode === 'web' ? AbortSignal.any([controller.signal, collectionStop.signal]) : controller.signal;
      const plan = await planner(intention, planningSignal, id ? url => { authorization = url; } : undefined, preferences, recovery, mode, webFeed?.observe, webFeed?.counts);
      if (mode === 'web' || wildcard) {
        const videos = webFeed ? await webFeed.finish(plan.videos) : await metadata(plan.videos, controller.signal);
        if (!videos.length) throw new Error('WEB_SEARCH_NO_SOURCED_VIDEOS');
        const result = { videos, searches: plan.searches, ...(wildcard ? { search_details: webFeed.searchDetails() } : {}) };
        if (streaming) { streamReply({ type: 'result', ...result }); res.end(); }
        else reply(200, result);
      } else reply(200, plan);
    } catch (error) {
      const code = safeErrors.has(error?.message) ? error.message : 'CONNECTOR_FAILED';
      if (res.headersSent) { streamReply({ type: 'error', error: code }); res.end(); }
      else reply(400, { error: code });
    }
    finally { webFeed?.close(); clearTimeout(deadline); res.off('close', abort); active = null; authorization = null; requestId = null; resolveIdle(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, async close() { closing = true; active?.abort(); for (const job of youtubeJobs) job.abort(); await new Promise(resolve => server.close(resolve)); await idle; await signOut(); } };
}
export function runConnector(extensionId = process.env.MYTUBE_EXTENSION_ID ?? EXTENSION_ID) {
  return startConnector({ extensionId }).then(connector => {
    console.log('MyTube connector is ready on this PC. Keep this process running while using MyTube.');
    console.log('Submitting a description sends it to OpenAI and can use your ChatGPT plan allowance.');
    console.log('YouTube key: Windows-protected storage (npm run key:setup), or explicit development environment/.secrets fallback. Credentials are never returned to the extension or logged.');
    console.log('ChatGPT stays connected in memory until sign-out, expiry or connector shutdown. Ctrl+C stops and signs out.');
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true;
      try { await connector.close(); console.log('Connector stopped; ChatGPT session cleared.'); }
      catch { console.error('Session cleared locally; remote revocation was not confirmed. Disconnect MyTube in ChatGPT settings.'); }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(() => { console.error('Connector could not start. Its local port may already be in use.'); process.exitCode = 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runConnector();
