/** A1 public preflight only. Never reads credentials or starts OAuth. */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const discoveryUrl = 'https://auth.openai.com/.well-known/openid-configuration';
const issuer = 'https://auth.openai.com';
const output = new URL('../../results/a1-preflight.json', import.meta.url);
const evidence = {
  spike: 'A1',
  recorded_at: new Date().toISOString(),
  runtime: process.version,
  status: 'BLOCKED',
  verdict: null,
  checks: [],
  oauth_attempted: false,
  inference_requests: 0,
  account_eligibility: 'NOT_VERIFIED',
  open_source_eligibility: 'NOT_VERIFIED',
  consent: 'NOT_REQUESTED',
};

function safeCode(error) {
  // Do not serialize messages, stacks, response bodies, URLs, or headers.
  const code = error.cause?.code ?? error.code ?? error.name;
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code ?? '') ? code : 'NETWORK_OR_RUNTIME_ERROR';
}

async function checkLoopback() {
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    evidence.checks.push({ check: 'loopback_bind', passed: true });
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

function trustedEndpoint(value) {
  try {
    const url = new URL(value);
    return url.origin === issuer && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

async function checkDiscovery() {
  const response = await fetch(discoveryUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' },
  });
  evidence.checks.push({ check: 'oidc_discovery_http', passed: response.ok, http_status: response.status });
  if (!response.ok) throw new Error('PREFLIGHT_STOP');
  const document = await response.json();
  const valid = document.issuer === issuer
    && document.authorization_endpoint === `${issuer}/api/accounts/authorize`
    && document.token_endpoint === `${issuer}/api/accounts/oauth/token`
    && trustedEndpoint(document.jwks_uri)
    && trustedEndpoint(document.revocation_endpoint);
  evidence.checks.push({ check: 'oidc_discovery_contract', passed: valid });
  if (!valid) throw new Error('PREFLIGHT_STOP');
}

if (process.argv.slice(2).length) {
  console.error('Usage: node spikes/a1-openai-login/preflight.mjs');
  process.exitCode = 2;
} else {
  let stage = 'loopback_bind';
  try {
    await checkLoopback();
    stage = 'oidc_discovery';
    await checkDiscovery();
    evidence.status = 'PREFLIGHT_PASSED';
    evidence.next_action = 'Confirm project/account eligibility, then implement and run the consented OAuth test. A1 is not yet validated.';
  } catch (error) {
    evidence.blocked_at = stage;
    if (error.message !== 'PREFLIGHT_STOP') {
      evidence.checks.push({ check: stage, passed: false, error_code: safeCode(error) });
    }
    evidence.next_action = 'Resolve the recorded preflight failure before OAuth. Re-run this command in a terminal with normal network access if this environment restricts networking.';
    process.exitCode = 1;
  }
  await mkdir(new URL('./', output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${fileURLToPath(output)}`);
}
