import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const INTENT = Object.freeze({ topic: 'aviation', min_minutes: 20, max_minutes: 90, exclude_shorts: true });

// Only application-owned codes reach the terminal or evidence. Never log an
// upstream error object: it can contain credentials, claims, URLs, or bodies.
export class Failure extends Error {
  constructor(code, httpStatus) { super(code); this.name = 'Failure'; this.httpStatus = httpStatus; }
}
export function requireThat(condition, code) {
  if (!condition) throw new Failure(code);
}
export function sameSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && Buffer.byteLength(a) === Buffer.byteLength(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function freshAttempt() {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + 5 * 60_000,
  };
}
export function authEndpoint(value) {
  try {
    const url = new URL(value);
    requireThat(url.origin === ISSUER && !url.username && !url.password
      && !url.search && !url.hash, 'UNTRUSTED_ENDPOINT');
    return url.href;
  } catch { throw new Failure('UNTRUSTED_ENDPOINT'); }
}
export function validateDiscovery(doc) {
  requireThat(doc?.issuer === ISSUER
    && doc.authorization_endpoint === `${ISSUER}/api/accounts/authorize`
    && doc.token_endpoint === `${ISSUER}/api/accounts/oauth/token`, 'DISCOVERY_CONTRACT');
  authEndpoint(doc.jwks_uri);
  authEndpoint(doc.revocation_endpoint);
  // This small POC deliberately supports RS256 only; never fall back to an
  // algorithm supplied by an unverified JWT header.
  requireThat(doc.id_token_signing_alg_values_supported?.includes('RS256'), 'SIGNING_ALGORITHM_UNSUPPORTED');
  return doc;
}
export function authorizationUrl(attempt, registration, redirectUri) {
  const params = new URLSearchParams({
    client_id: registration.client_id ?? 'dynamic_agent_client',
    ext_agent_host_id: registration.host_id,
    response_type: 'code', redirect_uri: redirectUri, scope: SCOPES,
    resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
    code_challenge_method: 'S256', code_challenge: attempt.challenge,
  });
  if (!registration.client_id) params.set('agent_name_hint', 'MyTube');
  return `${ISSUER}/api/accounts/authorize?${params}`;
}
export function callbackResult(rawUrl, host, method, attempt, redirectUri, savedClientId) {
  const expected = new URL(redirectUri);
  requireThat(method === 'GET' && host === expected.host, 'CALLBACK_ORIGIN');
  requireThat(typeof rawUrl === 'string' && rawUrl.length <= 8192
    && rawUrl.startsWith('/auth/callback?'), 'CALLBACK_PATH');
  const url = new URL(rawUrl, expected.origin);
  requireThat(url.origin === expected.origin && url.pathname === '/auth/callback' && !url.hash, 'CALLBACK_PATH');
  for (const key of url.searchParams.keys()) {
    requireThat(url.searchParams.getAll(key).length === 1, 'CALLBACK_DUPLICATE_PARAMETER');
  }
  requireThat(Date.now() < attempt.expiresAt, 'CALLBACK_EXPIRED');
  requireThat(sameSecret(url.searchParams.get('state'), attempt.state), 'CALLBACK_STATE');
  requireThat(!url.searchParams.has('error'), 'AUTHORIZATION_DENIED');
  const clientId = url.searchParams.get('client_id') ?? savedClientId;
  requireThat(typeof clientId === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId), 'CALLBACK_CLIENT_ID');
  requireThat(!savedClientId || clientId === savedClientId, 'CALLBACK_CLIENT_CHANGED');
  const code = url.searchParams.get('code');
  requireThat(typeof code === 'string' && code.length > 0 && code.length <= 4096
    && !/[\x00-\x20\x7f]/.test(code), 'CALLBACK_CODE');
  return { code, clientId };
}
export function validateTokenResponse(tokens) {
  requireThat(tokens && typeof tokens === 'object', 'TOKEN_RESPONSE_INVALID');
  for (const key of ['access_token', 'refresh_token', 'id_token']) {
    requireThat(typeof tokens[key] === 'string' && tokens[key].length > 0
      && tokens[key].length <= 32768 && !/[\x00-\x20\x7f]/.test(tokens[key]), 'TOKEN_RESPONSE_INVALID');
  }
  requireThat(tokens.token_type?.toLowerCase() === 'bearer'
    && Number.isSafeInteger(tokens.expires_in) && tokens.expires_in > 0, 'TOKEN_RESPONSE_INVALID');
  const scopes = new Set(typeof tokens.scope === 'string' ? tokens.scope.split(' ') : []);
  requireThat(['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'].every(scope => scopes.has(scope)), 'PLAN_PERMISSION_MISSING');
}
export async function verifyIdentity(idToken, jwks, clientId, nonce, priorIdentityHash) {
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: ISSUER, audience: clientId, algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5,
    });
    requireThat(typeof payload.sub === 'string' && payload.sub.length > 0, 'IDENTITY_INVALID');
    requireThat(sameSecret(payload.nonce, nonce), 'IDENTITY_INVALID');
    requireThat(typeof payload.iat === 'number' && payload.iat <= Date.now() / 1000 + 5, 'IDENTITY_INVALID');
    if (Array.isArray(payload.aud) && payload.aud.length > 1) {
      requireThat(payload.azp === clientId, 'IDENTITY_INVALID');
    }
    requireThat(payload.azp === undefined || payload.azp === clientId, 'IDENTITY_INVALID');
    const identityHash = createHash('sha256').update(JSON.stringify([ISSUER, clientId, payload.sub])).digest('hex');
    requireThat(!priorIdentityHash || sameSecret(priorIdentityHash, identityHash), 'IDENTITY_INVALID');
    return identityHash;
  } catch { throw new Failure('IDENTITY_INVALID'); }
}
export function selectModel(catalog, requested) {
  requireThat(Array.isArray(catalog?.models), 'MODEL_CATALOG_INVALID');
  const models = catalog.models.filter(item => item?.visibility === 'list'
    && typeof item.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.slug));
  const model = requested ? models.find(item => item.slug === requested) : models[0];
  requireThat(model, 'MODEL_UNAVAILABLE');
  return model.slug;
}
export function inferenceBody(model) {
  return {
    model, store: false, stream: true,
    instructions: 'Return only one JSON object, without Markdown or explanation. Use exactly the keys topic, min_minutes, max_minutes, exclude_shorts. Use topic "aviation".',
    input: [{ role: 'user', content: 'Represent this viewing intention: serious technical aviation accident investigations, 20 to 90 minutes, excluding Shorts. Use integer minutes and a boolean for exclude_shorts.' }],
  };
}
function validateIntent(response) {
  requireThat(response?.status === 'completed' && Array.isArray(response.output), 'INFERENCE_INCOMPLETE');
  const text = response.output.filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text')
    .map(item => item.text).join('');
  let value;
  try { value = JSON.parse(text); } catch { throw new Failure('INTENT_JSON_INVALID'); }
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(INTENT).length
    && Object.entries(INTENT).every(([key, expected]) => value[key] === expected), 'INTENT_SCHEMA_INVALID');
  // Do not return arbitrary model-generated strings to logs or files.
  return true;
}
export function responseMediaType(response) {
  const value = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  // Only fixed labels enter reports, never arbitrary upstream header values.
  return ['text/event-stream', 'application/json', 'text/html', 'text/plain', 'application/octet-stream'].includes(value)
    ? value : value ? 'other' : 'missing';
}
export async function consumeStream(response, validateResponse = validateIntent, observeEvent = () => {}) {
  // A live SIWC response returned HTTP 200 without Content-Type. Missing
  // metadata is not proof of SSE: only successful bounded frame parsing and
  // response.completed with the exact intent schema can establish success.
  if (!['text/event-stream', 'missing'].includes(responseMediaType(response)) || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Failure('STREAM_CONTENT_TYPE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Failure('STREAM_TRUNCATED');
      total += value.byteLength;
      requireThat(total <= 2 * 1024 * 1024, 'STREAM_TOO_LARGE');
      buffer += decoder.decode(value, { stream: true });
      // CRLF and LF event framing, including separators split across chunks.
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { throw new Failure('STREAM_EVENT_INVALID'); }
        requireThat(event && typeof event === 'object', 'STREAM_EVENT_INVALID');
        observeEvent(event);
        requireThat(!['error', 'response.failed', 'response.incomplete'].includes(event.type), 'INFERENCE_FAILED');
        if (event.type === 'response.completed') return validateResponse(event.response);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readJson(response, limit = 512 * 1024, onBytes = () => {}) {
  requireThat(response.body, 'HTTP_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      onBytes(bytes); // Count only; never expose response contents to evidence.
      requireThat(bytes <= limit, 'HTTP_BODY_TOO_LARGE');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Failure('HTTP_JSON_INVALID'); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
