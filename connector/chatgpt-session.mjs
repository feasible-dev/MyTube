import { setTimeout as delay } from 'node:timers/promises';
import { DISCOVERY, RESOURCE, Failure, authEndpoint, authorizationUrl, freshAttempt, readJson,
  requireThat, validateDiscovery, validateTokenResponse, verifyIdentity, selectModel, consumeStream } from '../spikes/a1-openai-login/protocol.mjs';

function planningError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'CHATGPT_TIMEOUT';
  if (!(error instanceof Failure)) return 'CHATGPT_FAILED';
  if (error.message === 'ACCESS_TOKEN_EXPIRED') return 'CHATGPT_SIGN_IN_REQUIRED';
  if (error.message === 'HTTP_REQUEST_REJECTED') {
    return error.httpStatus === 401 ? 'CHATGPT_SIGN_IN_REQUIRED'
      : error.httpStatus === 403 ? 'CHATGPT_ACCESS_DENIED'
      : error.httpStatus === 429 ? 'CHATGPT_LIMIT_REACHED'
      : error.httpStatus >= 500 ? 'CHATGPT_UNAVAILABLE' : 'CHATGPT_REQUEST_REJECTED';
  }
  if (['INVALID_GENERATED_RESPONSE', 'INVALID_GENERATED_JSON', 'INVALID_RESPONSE_OUTPUT', 'UNEXPECTED_OUTPUT_TYPE'].includes(error.message)) return 'INVALID_SEARCH_PLAN';
  if (['INVALID_PLAN_SUBJECTS', 'OFF_TOPIC_SEARCH_PLAN', 'REPEATED_SEARCH_QUERIES'].includes(error.message)) return error.message;
  if (['INFERENCE_INCOMPLETE', 'INFERENCE_FAILED', 'STREAM_TRUNCATED'].includes(error.message)) return 'CHATGPT_RESPONSE_INCOMPLETE';
  if (error.message === 'MODEL_REFUSAL') return 'CHATGPT_REFUSED';
  return ['CLEANUP_REQUIRED', 'INVALID_INTENTION', 'WEB_SEARCH_NO_SOURCED_VIDEOS', 'WEB_SEARCH_LIMIT_REACHED'].includes(error.message) ? error.message : 'CHATGPT_FAILED';
}

// Tokens live only in this closure. The old one-shot A1 experiment is unchanged.
export function createChatGPTSession({ registration, saveRegistration, authorize, fetchImpl = fetch, now = Date.now }) {
  let tokens, discovery, clientId, model, expiresAt = 0, busy = false;
  async function request(url, init = {}, signal) {
    if (signal?.aborted) throw new Failure('CANCELLED');
    requireThat(url === DISCOVERY || url === `${RESOURCE}/models` || url === `${RESOURCE}/responses`
      || (discovery && [discovery.token_endpoint, discovery.jwks_uri, discovery.revocation_endpoint].includes(url)), 'UNTRUSTED_ENDPOINT');
    if (!url.startsWith(`${RESOURCE}/`)) authEndpoint(url);
    const deadline = AbortSignal.timeout(url.endsWith('/responses') ? 120000 : 15000);
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Failure('HTTP_REQUEST_REJECTED', response.status); }
    return response;
  }
  async function clearSession() {
    const previous = tokens; tokens = undefined; model = undefined; expiresAt = 0;
    if (!previous) return;
    let acknowledged = false;
    try {
      if (typeof previous.refresh_token === 'string' && previous.refresh_token.length > 0
        && previous.refresh_token.length <= 32768 && !/[\x00-\x20\x7f]/.test(previous.refresh_token)) {
        for (let i = 0; i < 2; i++) {
          try {
            const response = await request(discovery.revocation_endpoint, { method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: previous.refresh_token, token_type_hint: 'refresh_token', client_id: clientId }) });
            await response.body?.cancel().catch(() => {});
            requireThat(response.status === 200, 'REVOCATION_NOT_CONFIRMED'); acknowledged = true; break;
          } catch (error) { if (i === 1 || (error instanceof Failure && error.httpStatus < 500)) break; await delay(300); }
        }
      }
    } finally { previous.access_token = previous.refresh_token = previous.id_token = undefined; }
    if (!acknowledged) throw new Failure('CLEANUP_REQUIRED');
  }
  return Object.freeze({
    async connect(signal, showAuthorization) { return this.plan(null, signal, showAuthorization); },
    async plan(task, signal, showAuthorization) {
      if (busy) throw new Failure('CONNECTOR_BUSY'); busy = true;
      let reconnected = false;
      try {
        for (;;) {
          let exchangeUncertain = false, phase = 'authorization';
          try {
            if (signal?.aborted) throw new Failure('CANCELLED');
            // Leave enough lifetime for the bounded inference. Renewal is explicit
            // reauthorization for now; no unvalidated refresh-token implementation.
            if (tokens && now() + 125000 >= expiresAt) await clearSession();
            if (!tokens) {
              discovery = validateDiscovery(await readJson(await request(DISCOVERY, {}, signal)));
              const attempt = freshAttempt();
              const callback = await authorize(attempt, uri => authorizationUrl(attempt, registration, uri), signal, showAuthorization);
              if (signal?.aborted) throw new Failure('CANCELLED');
              clientId = callback.clientId; registration.client_id = clientId; await saveRegistration(registration);
              exchangeUncertain = true;
              tokens = await readJson(await request(discovery.token_endpoint, { method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: callback.code,
                  code_verifier: attempt.verifier, redirect_uri: callback.redirectUri, resource: RESOURCE }) }, signal));
              validateTokenResponse(tokens);
              expiresAt = now() + tokens.expires_in * 1000;
              const jwks = await readJson(await request(discovery.jwks_uri, {}, signal));
              registration.identity_hash = await verifyIdentity(tokens.id_token, jwks, clientId, attempt.nonce, registration.identity_hash);
              await saveRegistration(registration); exchangeUncertain = false;
            }
            phase = 'catalog';
            const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' };
            model ??= selectModel(await readJson(await request(`${RESOURCE}/models`, { headers }, signal), 8 * 1024 * 1024));
            requireThat(now() + 5000 < expiresAt, 'ACCESS_TOKEN_EXPIRED');
            // Connection preflight authenticates and checks access without inference.
            if (task === null) return;
            phase = 'build';
            const batch = Array.isArray(task.tasks);
            const tasks = batch ? task.tasks : [task];
            requireThat(tasks.length > 0 && tasks.length <= 4, 'INFERENCE_TASK_INVALID');
            const bodies = tasks.map(child => child.build(model));
            for (const body of bodies) {
            requireThat(body.model === model && body.store === false && body.stream === true && Array.isArray(body.input)
              && Buffer.byteLength(JSON.stringify(body)) <= 16384, 'INFERENCE_TASK_INVALID');
            }
            phase = 'inference';
            const batchAbort = new AbortController();
            const workSignal = signal ? AbortSignal.any([signal, batchAbort.signal]) : batchAbort.signal;
            const execute = async (child, body) => {
            const childSignal = child.timeoutMs === 30000 ? AbortSignal.any([workSignal, AbortSignal.timeout(30000)]) : workSignal;
            const response = await request(`${RESOURCE}/responses`, { method: 'POST',
              headers: { ...headers, Accept: 'text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, childSignal);
            const result = await consumeStream(response, value => {
              requireThat(![tokens.access_token, tokens.refresh_token, tokens.id_token].some(secret => JSON.stringify(value).includes(secret)), 'CREDENTIAL_ECHO_REJECTED');
              return child.validate(value, model);
            }, event => {
              requireThat(![tokens.access_token, tokens.refresh_token, tokens.id_token].some(secret => JSON.stringify(event).includes(secret)), 'CREDENTIAL_ECHO_REJECTED');
              if (!childSignal.aborted) child.observeEvent?.(event);
            });
            requireThat(![tokens.access_token, tokens.refresh_token, tokens.id_token].some(secret => JSON.stringify(result).includes(secret)), 'CREDENTIAL_ECHO_REJECTED');
            if (childSignal.aborted) throw childSignal.reason;
            await child.accept(result);
            };
            // One verified session and one exclusive lock for the entire batch.
            // Stop and join siblings before credential cleanup or reauthorization.
            let next = 0, fatal;
            const failures = [];
            const worker = async () => {
              while (next < tasks.length && !workSignal.aborted) {
                const index = next++;
                try { await execute(tasks[index], bodies[index]); }
                catch (error) {
                  if (batch && ['INVALID_SEARCH_PLAN', 'WEB_SEARCH_NO_SOURCED_VIDEOS', 'WEB_SEARCH_LIMIT_REACHED', 'CHATGPT_RESPONSE_INCOMPLETE', 'CHATGPT_REFUSED', 'CHATGPT_TIMEOUT'].includes(planningError(error))) {
                    failures.push(error); continue;
                  }
                  fatal ??= error; batchAbort.abort();
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, worker));
            if (fatal) throw fatal;
            if (signal?.aborted) throw new Failure('CANCELLED');
            if (failures.length === tasks.length) throw failures[0];
            phase = 'accept';
            if (batch) await task.accept();
            return;
          } catch (error) {
            const rejectedAuth = ['catalog', 'inference'].includes(phase) && error instanceof Failure
              && ((error.message === 'HTTP_REQUEST_REJECTED' && error.httpStatus === 401) || error.message === 'ACCESS_TOKEN_EXPIRED');
            const code = planningError(error);
            // Cancelling retrieval must not revoke an already verified login.
            // Cancellation during token/identity verification still clears it.
            const cancelledRequest = signal?.aborted && ['catalog', 'inference', 'validation', 'build'].includes(phase)
              && (error?.name === 'AbortError' || error?.name === 'TimeoutError'
                || (error instanceof Failure && error.message === 'CANCELLED'));
            if (cancelledRequest) throw new Failure('CANCELLED');
            // Keep a verified session on ordinary output/admission/transport failures.
            // Identity, token, credential-echo and protocol-integrity failures still clear it.
            const ordinaryFailure = ['catalog', 'inference', 'validation', 'build'].includes(phase)
              && (['WEB_SEARCH_NO_SOURCED_VIDEOS', 'WEB_SEARCH_LIMIT_REACHED', 'INVALID_SEARCH_PLAN', 'INVALID_PLAN_SUBJECTS', 'OFF_TOPIC_SEARCH_PLAN', 'REPEATED_SEARCH_QUERIES', 'CHATGPT_RESPONSE_INCOMPLETE', 'CHATGPT_REFUSED', 'INVALID_INTENTION',
                'CHATGPT_ACCESS_DENIED', 'CHATGPT_LIMIT_REACHED', 'CHATGPT_UNAVAILABLE', 'CHATGPT_REQUEST_REJECTED', 'CHATGPT_TIMEOUT'].includes(code)
                || (['catalog', 'inference'].includes(phase) && error instanceof TypeError));
            if (ordinaryFailure && !signal?.aborted) throw new Failure(code);
            const hadTokens = Boolean(tokens);
            await clearSession();
            if (exchangeUncertain && !hadTokens) throw new Failure('CLEANUP_REQUIRED');
            if (rejectedAuth && !reconnected && !signal?.aborted) { reconnected = true; continue; }
            throw new Failure(signal?.aborted ? 'CANCELLED' : code);
          }
        }
      } finally { busy = false; }
    },
    async signOut() {
      if (busy) throw new Failure('CONNECTOR_BUSY'); busy = true;
      try { await clearSession(); } finally { busy = false; }
    },
  });
}
