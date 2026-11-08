import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('Windows DPAPI encrypts and decrypts a synthetic key without accessing the real store', { skip: process.platform !== 'win32' }, async () => {
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/windows-key.ps1', import.meta.url)), '-Mode', 'RoundTripTest'],
    { windowsHide: true, timeout: 15000 }, (error, output) => error ? reject(new Error('SYNTHETIC_DPAPI_TEST_FAILED')) : resolve(output));
    child.stdin.end();
  });
  assert.equal(stdout, 'DPAPI_ROUNDTRIP_OK');
});
