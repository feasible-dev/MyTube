import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { listenForCallback } from './callback.mjs';
import { runFlow } from './flow.mjs';
import { Failure, requireThat } from './protocol.mjs';

const privateDir = new URL('../../.private/', import.meta.url);
const registrationFile = new URL('a1-registration.json', privateDir);
const lockFile = new URL('a1.lock', privateDir);
const execFileAsync = promisify(execFile);

async function openBrowser(url) {
  // Never interpolate a URL into shell code or print it. The only destination
  // is built by authorizationUrl from fixed endpoints and encoded parameters.
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:MYTUBE_AUTH_URL'], {
      env: { ...process.env, MYTUBE_AUTH_URL: url }, windowsHide: true, timeout: 10_000,
    });
  } else {
    await execFileAsync(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { timeout: 10_000 });
  }
}

async function readRegistration() {
  try {
    requireThat(!(await lstat(registrationFile)).isSymbolicLink(), 'REGISTRATION_FILE_UNSAFE');
    const record = JSON.parse(await readFile(registrationFile, 'utf8'));
    requireThat(record.version === 1
      && /^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.host_id)
      && (record.client_id === null || /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(record.client_id))
      && (record.identity_hash === null || /^[a-f0-9]{64}$/.test(record.identity_hash)), 'REGISTRATION_FILE_INVALID');
    return { version: 1, host_id: record.host_id, client_id: record.client_id, identity_hash: record.identity_hash };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, host_id: `urn:uuid:${randomUUID()}`, client_id: null, identity_hash: null };
    throw new Failure('REGISTRATION_FILE_INVALID');
  }
}
async function saveRegistration(record) {
  const temporary = new URL(`a1-registration-${randomUUID()}.tmp`, privateDir);
  // Explicit field selection ensures tokens can never accidentally be spread
  // into persistent registration metadata.
  const safe = { version: 1, host_id: record.host_id, client_id: record.client_id, identity_hash: record.identity_hash };
  try {
    await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, registrationFile);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function runLogin({ spike = 'A1', inferenceTask, notices, finalizeReport } = {}) {
  const args = process.argv.slice(2);
  const options = { plan: 'unknown', model: undefined };
  for (let i = 0; i < args.length; i += 2) {
    requireThat(['--plan', '--model'].includes(args[i]) && args[i + 1], 'INVALID_ARGUMENTS');
    options[args[i].slice(2)] = args[i + 1];
  }
  requireThat(['unknown', 'plus', 'pro'].includes(options.plan), 'INVALID_ARGUMENTS');
  requireThat(!options.model || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.model), 'INVALID_ARGUMENTS');
  requireThat(process.stdin.isTTY && process.stdout.isTTY, 'INTERACTIVE_TERMINAL_REQUIRED');
  console.log(`MyTube ${spike}: one consented sign-in and at most one AI request.`);
  for (const line of notices ?? ['OpenAI will receive a fixed aviation-video intention, not your YouTube history.']) console.log(line);
  console.log('The request uses your granted ChatGPT plan access and can consume its allowance/credits.');
  console.log('Tokens stay in memory. Session revocation will be attempted when the test ends.');
  console.log('Close this process with Ctrl+C to cancel. Never paste tokens or callback URLs into chat.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let consent;
  try { consent = await terminal.question('Type continue to open Continue with ChatGPT: '); }
  finally { terminal.close(); }
  if (consent.trim() !== 'continue') { console.log('Cancelled. No authorization started.'); return; }

  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  requireThat(!(await lstat(privateDir)).isSymbolicLink(), 'PRIVATE_DIRECTORY_UNSAFE');
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch { throw new Failure('ANOTHER_RUN_OR_STALE_LOCK'); }
  const controller = new AbortController();
  const cancel = () => { controller.abort(); console.log('Cancelling; waiting for bounded session cleanup.'); };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const registration = await readRegistration();
    await saveRegistration(registration);
    const report = await runFlow({
      registration, saveRegistration, signal: controller.signal, requestedModel: options.model, inferenceTask,
      authorize: async (attempt, makeUrl) => {
        const listener = await listenForCallback(attempt, registration.client_id, controller.signal);
        try {
          console.log('Opening your browser. Authenticate and review permissions there.');
          await openBrowser(makeUrl(listener.redirectUri));
          const callback = await listener.result;
          console.log('Callback received. Verifying identity, permissions, and the API response.');
          return { ...callback, redirectUri: listener.redirectUri };
        } finally { await listener.close(); }
      },
    });
    report.spike = spike;
    report.plan_self_reported = options.plan;
    report.plan_tier_verified = false;
    if (finalizeReport) {
      try { await finalizeReport(report); }
      catch {
        report.status = 'BLOCKED'; report.failed_stage = 'result_export'; report.failure_code = 'RESULT_EXPORT_FAILED';
      }
    }
    const results = new URL('../../results/', import.meta.url);
    await mkdir(results, { recursive: true });
    // Unique reports preserve earlier evidence; no tokens or raw responses.
    const reportFile = new URL(`${spike.toLowerCase()}-run-${Date.now()}-${randomUUID()}.json`, results);
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
    console.log(`Sanitized evidence: results/${reportFile.pathname.split('/').at(-1)}`);
    if (report.session_revocation === 'UNCONFIRMED') {
      console.log('Remote revocation was NOT confirmed. Disconnect MyTube in ChatGPT Settings before continuing.');
    }
    console.log('A technical pass is not a billing, Plus-compatibility, security-audit, or product GO verdict.');
    if (report.status !== 'TECHNICAL_PASS') process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    await lock.close();
    await unlink(lockFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runLogin().catch(error => {
  console.error(error instanceof Failure ? error.message : 'LOCAL_RUNTIME_ERROR');
  console.error('Stopped. Do not share credentials or raw diagnostic output. See the A1 README.');
  process.exitCode = 1;
});
