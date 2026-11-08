import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionIdForStart } from './start.mjs';

test('first startup remembers only a validated extension ID; subsequent startup needs no prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mytube-start-')), path = join(dir, 'setup.json');
  const first = 'a'.repeat(32), second = 'b'.repeat(32);
  try {
    assert.equal(await extensionIdForStart({ env: {}, path, ask: async () => first }), first);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { extensionId: first });
    assert.equal(await extensionIdForStart({ env: {}, path, ask: async () => assert.fail('Should remember ID') }), first);
    assert.equal(await extensionIdForStart({ env: {}, path, configure: true, ask: async () => second }), second);
    assert.equal(await extensionIdForStart({ env: { MYTUBE_EXTENSION_ID: first }, path }), first);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { extensionId: second });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid pasted values and malformed stored settings never broaden connector access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mytube-start-')), path = join(dir, 'setup.json');
  try {
    await assert.rejects(extensionIdForStart({ env: {}, path, ask: async () => 'SYNTHETIC_API_KEY_NOT_AN_EXTENSION_ID' }), /32-letter extension ID/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await writeFile(path, JSON.stringify({ extensionId: '*', key: 'SYNTHETIC' }));
    await assert.rejects(extensionIdForStart({ env: {}, path, ask: async () => assert.fail() }), /Local setup is invalid/);
    await assert.rejects(extensionIdForStart({ env: { MYTUBE_EXTENSION_ID: '*' }, path }), /Invalid extension ID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
