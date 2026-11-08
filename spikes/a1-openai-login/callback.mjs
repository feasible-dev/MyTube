import { createServer } from 'node:http';
import { callbackResult, Failure } from './protocol.mjs';

/** One in-memory transaction, loopback only; no HTML assets or request logs. */
export async function listenForCallback(attempt, savedClientId, signal, { application = false } = {}) {
  let resolveCallback, rejectCallback, consumed = false, redirectUri;
  const result = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // The user may still be opening their browser when an abort occurs.
  result.catch(() => {});
  const finish = (error, value) => {
    if (consumed) return;
    consumed = true;
    if (error) rejectCallback(error); else resolveCallback(value);
  };
  const server = createServer({ maxHeaderSize: 12 * 1024 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Connection', 'close');
    if (consumed) { res.writeHead(409); res.end('Sign-in attempt already handled.'); return; }
    try {
      const value = callbackResult(req.url, req.headers.host, req.method, attempt, redirectUri, savedClientId);
      finish(null, value);
      res.end(application ? 'Sign-in received. Return to MyTube; your search will continue. This window will close automatically when opened by MyTube.'
        : 'Callback received. Return to the terminal for verification. You may close this tab.');
    } catch (error) {
      // A forged callback must not cancel the legitimate pending transaction.
      // Only a state-validated denial terminates it.
      if (error instanceof Failure && error.message === 'AUTHORIZATION_DENIED') finish(error);
      res.writeHead(400);
      res.end('Callback rejected. Return to the terminal.');
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  server.maxConnections = 8;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const timer = setTimeout(() => finish(new Failure('CALLBACK_TIMEOUT')), Math.max(1, attempt.expiresAt - Date.now()));
  const abort = () => finish(new Failure('CANCELLED'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    redirectUri, result,
    async close() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      finish(new Failure('CANCELLED'));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
