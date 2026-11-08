import { createInterpretationTask } from './interpretation-task.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createChatGPTSession } from './chatgpt-session.mjs';
import { listenForCallback } from '../spikes/a1-openai-login/callback.mjs';
import { Failure } from '../spikes/a1-openai-login/protocol.mjs';
import { createIntentionTask } from './task.mjs';
import { runWebStages } from './web-stages.mjs';
import { runWildcardStages } from './wildcard-stages.mjs';

const directory = new URL('../.private/', import.meta.url);
// Same MyTube host registration and lock as the existing local experiments.
// This record contains no tokens; the established flow keeps tokens in memory.
const registrationFile = new URL('a1-registration.json', directory);
const lockFile = new URL('a1.lock', directory);
const exec = promisify(execFile);
async function openAuthorization(url) {
  const env = { ...process.env, MYTUBE_AUTH_URL: url };
  delete env.MYTUBE_YOUTUBE_API_KEY;
  if (process.platform === 'win32') await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:MYTUBE_AUTH_URL'], { env, windowsHide: true, timeout: 10000 });
  else await exec(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { env, timeout: 10000 });
}
async function readRegistration() {
  try {
    if ((await lstat(registrationFile)).isSymbolicLink()) throw new Failure('REGISTRATION_FILE_INVALID');
    const r = JSON.parse(await readFile(registrationFile, 'utf8'));
    if (r.version !== 1 || !/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.host_id)
      || (r.client_id !== null && !/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(r.client_id))
      || (r.identity_hash !== null && !/^[a-f0-9]{64}$/.test(r.identity_hash))) throw new Failure('REGISTRATION_FILE_INVALID');
    return { version: 1, host_id: r.host_id, client_id: r.client_id, identity_hash: r.identity_hash };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, host_id: `urn:uuid:${randomUUID()}`, client_id: null, identity_hash: null };
    throw new Failure('REGISTRATION_FILE_INVALID');
  }
}
async function saveRegistration(r) {
  const temporary = new URL(`connector-registration-${randomUUID()}.tmp`, directory);
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, host_id: r.host_id,
      client_id: r.client_id, identity_hash: r.identity_hash }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, registrationFile);
  } finally { await unlink(temporary).catch(() => {}); }
}
let session;
export async function signOutChatGPT() { if (session) await session.signOut(); }
export async function connectChatGPT(signal, showAuthorization) {
  return planWithChatGPT(null, signal, showAuthorization, undefined, undefined, 'connect');
}
export async function planWithChatGPT(intention, signal, showAuthorization, preferences, recovery, mode = 'plan', onCandidates, getCounts) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Failure('REGISTRATION_FILE_INVALID');
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch { throw new Failure('CONNECTOR_BUSY'); }
  try {
    let plan;
    if (!session) {
      const registration = await readRegistration(); await saveRegistration(registration);
      session = createChatGPTSession({ registration, saveRegistration,
      authorize: async (attempt, makeUrl, authSignal, show) => {
        const callback = await listenForCallback(attempt, registration.client_id, authSignal, { application: true });
        try {
          console.log('Complete Continue with ChatGPT in your browser. No callback URL or token should be copied.');
          if (show) show(makeUrl(callback.redirectUri));
          else await openAuthorization(makeUrl(callback.redirectUri));
          return { ...await callback.result, redirectUri: callback.redirectUri };
        } finally { show?.(null); await callback.close(); }
      },
      });
    }
    if (mode === 'connect') { await session.connect(signal, showAuthorization); return { connected: true }; }
    if (mode === 'wildcard') {
      plan = await runWildcardStages({ intention, preferences, signal, publish: onCandidates,
        run: task => session.plan(task, signal, showAuthorization) });
    }
    else if (mode === 'web') plan = await runWebStages({ intention, preferences, recovery, signal, publish: onCandidates, getCounts,
      run: task => session.plan(task, signal, showAuthorization) });
    else await session.plan((mode === 'interpret' ? createInterpretationTask : createIntentionTask)(intention, value => { plan = value; }, preferences, recovery), signal, showAuthorization);
    if (!plan) throw new Failure('CHATGPT_FAILED');
    console.log('Search plan ready; ChatGPT session retained in connector memory.');
    return plan;
  } finally { await lock.close(); await unlink(lockFile); }
}
