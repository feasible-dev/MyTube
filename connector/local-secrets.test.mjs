import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadYouTubeKey } from './local-secrets.mjs';
import { prepareSecrets, parseSetupIdentity, assertSetupAccount, setupFailureMessage } from '../scripts/setup-secrets.mjs';

const fake = 'SYNTHETIC_YOUTUBE_KEY_NEVER_REAL_12345';
test('protected storage precedes legacy files and fails closed; explicit environment override wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mytube-key-order-')), path = join(dir, 'synthetic');
  try {
    await writeFile(path, `MYTUBE_YOUTUBE_API_KEY=${fake}\n`);
    assert.equal(await loadYouTubeKey({ env: {}, path, protectedKey: async () => fake + 'PROTECTED' }), fake + 'PROTECTED');
    assert.equal(await loadYouTubeKey({ env: {}, path, protectedKey: async () => null }), fake);
    await assert.rejects(loadYouTubeKey({ env: {}, path, protectedKey: async () => { throw new Error('YOUTUBE_KEY_INVALID'); } }), { message: 'YOUTUBE_KEY_INVALID' });
    assert.equal(await loadYouTubeKey({ env: { MYTUBE_YOUTUBE_API_KEY: fake + 'ENV' }, path,
      protectedKey: async () => assert.fail('Environment override must not access the store') }), fake + 'ENV');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('setup refuses an agent identity for the real private file before touching it', () => {
  for (const account of ['CodexSandboxOffline', 'CodexSandboxOnline']) {
    const identity = parseSetupIdentity(`"PC\\${account}","S-1-5-21-123-1003"`);
    assert.throws(() => assertSetupAccount(identity, true), { message: 'SECRET_SETUP_WRONG_ACCOUNT' });
    assert.doesNotThrow(() => assertSetupAccount(identity, false));
  }
  assert.doesNotThrow(() => assertSetupAccount(parseSetupIdentity('"PC\\PersonalUser","S-1-5-21-123-1001"'), true));
  assert.match(setupFailureMessage('SECRET_SETUP_WRONG_ACCOUNT'), /own Windows terminal/);
  assert.match(setupFailureMessage('SECRET_OWNER_FAILED'), /ownership/);
  assert.ok(!setupFailureMessage(fake).includes(fake));
});
test('private loader reads only synthetic fixtures; env wins and never mutates it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mytube-secrets-test-')), path = join(dir, 'synthetic');
  try {
    const env = {}; assert.equal(await loadYouTubeKey({ env, path }), null);
    await writeFile(path, `# Private fixture\nMYTUBE_YOUTUBE_API_KEY=${fake}\n`);
    assert.equal(await loadYouTubeKey({ env, path }), fake); assert.deepEqual(env, {});
    assert.equal(await loadYouTubeKey({ env: { MYTUBE_YOUTUBE_API_KEY: fake + 'ENV' }, path }), fake + 'ENV');
    for (const text of [`MYTUBE_YOUTUBE_API_KEY=${fake}\nOTHER=${fake}`, `MYTUBE_YOUTUBE_API_KEY=${fake}\nMYTUBE_YOUTUBE_API_KEY=${fake}`, `MYTUBE_YOUTUBE_API_KEY=$(echo ${fake})`, 'x'.repeat(8193)]) {
      await writeFile(path, text);
      await assert.rejects(loadYouTubeKey({ env, path }), error => error.message === 'YOUTUBE_KEY_INVALID' && !String(error.stack).includes(fake));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('setup preserves existing private contents and never includes them in its result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mytube-setup-test-')), path = pathToFileURL(join(dir, 'synthetic'));
  try {
    assert.deepEqual(await prepareSecrets(path), { created: true });
    await writeFile(path, `MYTUBE_YOUTUBE_API_KEY=${fake}\n`);
    assert.deepEqual(await prepareSecrets(path), { created: false });
    assert.equal(await readFile(path, 'utf8'), `MYTUBE_YOUTUBE_API_KEY=${fake}\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
