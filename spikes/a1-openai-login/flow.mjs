import { setTimeout as delay } from 'node:timers/promises';
import {
  DISCOVERY, RESOURCE, Failure, authEndpoint, authorizationUrl, consumeStream,
  freshAttempt, inferenceBody, readJson, requireThat, selectModel,
  validateDiscovery, validateTokenResponse, verifyIdentity,
  responseMediaType,
} from './protocol.mjs';

// Account catalogs can include substantial model metadata. Keep a separate,
// bounded allowance; token, discovery and JWKS responses retain 512 KiB.
const MODEL_CATALOG_LIMIT = 8 * 1024 * 1024;

/** Dependency injection is for offline tests, not user-configurable endpoints. */
export async function runFlow({ registration, saveRegistration, authorize, signal, requestedModel, fetchImpl = fetch, inferenceTask }) {
  const report = {
    spike: 'A1', recorded_at: new Date().toISOString(), status: 'BLOCKED', verdict: null,
    oauth_attempted: false, identity_verified: false, plan_permission_granted: false,
    inference_requests: 0, structured_response_validated: false,
    expiry_metadata_validated: false, expiration_observed: false,
    session_revocation: 'NOT_NEEDED', billing_verified: false,
  };
  let stage = 'discovery', tokens, discovery, clientId, validatedResult;
  const request = async (url, init = {}, cleanup = false) => {
    const allowed = url === DISCOVERY || url === `${RESOURCE}/models` || url === `${RESOURCE}/responses`
      || (discovery && [discovery.token_endpoint, discovery.jwks_uri, discovery.revocation_endpoint].includes(url));
    requireThat(allowed, 'UNTRUSTED_ENDPOINT');
    if (!url.startsWith(`${RESOURCE}/`)) authEndpoint(url);
    const deadline = AbortSignal.timeout(url === `${RESOURCE}/responses` ? 120_000 : 15_000);
    const response = await fetchImpl(url, {
      ...init, redirect: 'error',
      signal: signal && !cleanup ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Do not read or reflect upstream error bodies.
      throw new Failure('HTTP_REQUEST_REJECTED', response.status);
    }
    return response;
  };
  try {
    discovery = validateDiscovery(await readJson(await request(DISCOVERY)));
    stage = 'authorization';
    const attempt = freshAttempt();
    report.oauth_attempted = true;
    // authorize starts the listener before generating/opening the URL.
    const callback = await authorize(attempt, redirectUri => authorizationUrl(attempt, registration, redirectUri));
    clientId = callback.clientId;
    // Keep an issued registration even if token exchange subsequently fails.
    // No token or raw subject is persisted.
    registration.client_id = clientId;
    await saveRegistration(registration);
    stage = 'token_exchange';
    // If the response is lost after issuance, we cannot prove remote cleanup.
    report.session_revocation = 'UNCONFIRMED';
    tokens = await readJson(await request(discovery.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId, code: callback.code,
        code_verifier: attempt.verifier, redirect_uri: callback.redirectUri, resource: RESOURCE,
      }),
    }));
    // Even a malformed token response may include a revocable refresh token.
    report.session_revocation = 'UNCONFIRMED';
    stage = 'token_validation';
    validateTokenResponse(tokens);
    const receivedAt = Date.now();
    stage = 'identity_validation';
    const jwks = await readJson(await request(discovery.jwks_uri));
    const identityHash = await verifyIdentity(tokens.id_token, jwks, clientId, attempt.nonce, registration.identity_hash);
    registration.identity_hash = identityHash;
    await saveRegistration(registration);
    report.identity_verified = true;
    report.plan_permission_granted = true;
    report.expiry_metadata_validated = true;
    stage = 'model_catalog';
    const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' };
    report.model_catalog_limit_bytes = MODEL_CATALOG_LIMIT;
    const catalog = await readJson(await request(`${RESOURCE}/models`, { headers }), MODEL_CATALOG_LIMIT,
      bytes => { report.model_catalog_received_bytes = bytes; });
    const model = selectModel(catalog, requestedModel);
    report.model = model;
    requireThat(Date.now() + 5000 < receivedAt + tokens.expires_in * 1000, 'ACCESS_TOKEN_EXPIRED');
    // Optional application-owned task; never populated from a model response or CLI JSON.
    // A1's default request and validator remain unchanged.
    const body = inferenceTask ? inferenceTask.build(model) : inferenceBody(model);
    requireThat(body.model === model && body.store === false && body.stream === true
      && Array.isArray(body.input) && Buffer.byteLength(JSON.stringify(body)) <= 16384, 'INFERENCE_TASK_INVALID');
    stage = 'inference';
    report.inference_requests = 1;
    const response = await request(`${RESOURCE}/responses`, {
      method: 'POST', headers: { ...headers, Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    report.inference_http_status = response.status;
    report.inference_content_type = responseMediaType(response);
    report.inference_body_present = response.body !== null;
    validatedResult = await consumeStream(response, inferenceTask ? value => inferenceTask.validate(value, model) : undefined);
    if (inferenceTask) {
      const encoded = JSON.stringify(validatedResult);
      requireThat(typeof encoded === 'string' && ![tokens.access_token, tokens.refresh_token, tokens.id_token]
        .some(secret => encoded.includes(secret)), 'CREDENTIAL_ECHO_REJECTED');
    }
    report.structured_response_validated = true;
    report.status = 'TECHNICAL_PASS';
  } catch (error) {
    report.failed_stage = stage;
    report.failure_code = error instanceof Failure ? error.message : 'NETWORK_OR_RUNTIME_ERROR';
    if (error instanceof Failure && Number.isInteger(error.httpStatus)) report.http_status = error.httpStatus;
  } finally {
    if (tokens) {
      if (typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
        && tokens.refresh_token.length <= 32768 && !/[\x00-\x20\x7f]/.test(tokens.refresh_token)) {
        // Retry cleanup once after network/5xx failure, never inference. Both
        // attempts have independent deadlines and survive user cancellation.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await request(discovery.revocation_endpoint, {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: 'refresh_token', client_id: clientId }),
            }, true);
            await response.body?.cancel().catch(() => {});
            requireThat(response.status === 200, 'REVOCATION_NOT_CONFIRMED');
            report.session_revocation = 'ACKNOWLEDGED';
            break;
          } catch (error) {
            report.session_revocation = 'UNCONFIRMED';
            const retryable = !(error instanceof Failure) || error.httpStatus >= 500;
            if (!retryable || attempt === 1) break;
            await delay(300);
          }
        }
      }
      // Dropping references is not guaranteed memory zeroization in JavaScript.
      if (typeof tokens === 'object') {
        tokens.access_token = tokens.refresh_token = tokens.id_token = undefined;
      }
      tokens = undefined;
      if (report.session_revocation !== 'ACKNOWLEDGED' && report.status === 'TECHNICAL_PASS') {
        report.status = 'CLEANUP_REQUIRED';
      }
    }
  }
  // Export task data only after both validation and acknowledged cleanup. Never return tokens.
  if (inferenceTask && report.status === 'TECHNICAL_PASS') {
    try { await inferenceTask.accept(validatedResult); }
    catch {
      report.status = 'BLOCKED'; report.failed_stage = 'result_export'; report.failure_code = 'RESULT_EXPORT_FAILED';
    }
  }
  validatedResult = undefined;
  return report;
}
