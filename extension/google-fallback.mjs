import { googleResponseFailure, LiveSearchError } from './youtube-live.mjs';

export function waitForGoogle(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new LiveSearchError('CANCELLED')); return; }
    const cancel = () => { clearTimeout(timer); reject(new LiveSearchError('CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export function createGoogleGate() { return { active: 0, waiters: [], blockedUntil: 0, blockedCode: null }; }
async function enterGoogleGate(gate, signal) {
  if (signal?.aborted) throw new LiveSearchError('CANCELLED');
  if (gate.active < 2) { gate.active++; return; }
  await new Promise((resolve, reject) => {
    const entry = { resolve: () => { signal?.removeEventListener('abort', cancel); resolve(); } };
    const cancel = () => { gate.waiters = gate.waiters.filter(e => e !== entry); reject(new LiveSearchError('CANCELLED')); };
    gate.waiters.push(entry); signal?.addEventListener('abort', cancel, { once: true });
  });
}
// Shared queue across quick search, discovery and home refresh. At most one
// automatic retry per foreground search; no retry on quota, auth or access denial.
export function createGoogleFallbackFetch(fetchImpl, { gate = createGoogleGate(), retries = 1, wait = waitForGoogle, now = Date.now, onRetry = () => {} } = {}) {
  let retriesLeft = retries;
  const stats = { requests: 0, retries: 0 };
  const wrapped = async (url, init) => {
    if (new URL(url).origin !== 'https://www.googleapis.com') return fetchImpl(url, init);
    await enterGoogleGate(gate, init.signal);
    try {
      if (init.signal?.aborted) throw new LiveSearchError('CANCELLED');
      if (now() < gate.blockedUntil) throw new LiveSearchError(gate.blockedCode);
      while (true) {
        stats.requests++;
        const response = await fetchImpl(url, init);
        if (response.ok) return response;
        const error = await googleResponseFailure(response);
        if (error.code === 'RATE_LIMITED' && retriesLeft > 0 && (error.retryAfterMs ?? 0) <= 10000) {
          retriesLeft--; stats.retries++; onRetry();
          await wait(Math.max(1000, error.retryAfterMs ?? 2000), init.signal);
          if (init.signal?.aborted) throw new LiveSearchError('CANCELLED');
          if (now() < gate.blockedUntil) throw new LiveSearchError(gate.blockedCode);
          continue;
        }
        if (['RATE_LIMITED', 'QUOTA_EXCEEDED', 'ACCESS_OR_QUOTA_DENIED'].includes(error.code)) {
          gate.blockedCode = error.code;
          gate.blockedUntil = now() + Math.max(error.retryAfterMs ?? 0, error.code === 'RATE_LIMITED' ? 60000 : 300000);
        }
        throw error;
      }
    } finally {
      const next = gate.waiters.shift();
      if (next) next.resolve(); else gate.active--;
    }
  };
  Object.defineProperty(wrapped, 'stats', { get: () => ({ ...stats }) });
  return wrapped;
}
