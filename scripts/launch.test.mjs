import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchMode } from './launch.mjs';

test('launcher distinguishes fresh install, repeat start and updates without touching credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mytube-launch-'));
  const root = pathToFileURL(directory + '/');
  const write = (file, data) => writeFile(new URL(file, root), typeof data === 'string' ? data : JSON.stringify(data));
  try {
    await write('package.json', { version: '1.0.0', dependencies: { example: '2.0.0' } });
    assert.equal(await launchMode(root), 'setup');
    await mkdir(new URL('node_modules/example/', root), { recursive: true });
    await write('node_modules/example/package.json', { version: '2.0.0' });
    await mkdir(new URL('dist/brave/', root), { recursive: true });
    await write('dist/brave/manifest.json', { version: '1.0.0' });
    for (const file of ['app.js', 'live.js', 'background.js', 'index.html', 'style.css']) await write('dist/brave/' + file, 'fixture');
    assert.equal(await launchMode(root), 'setup');
    await write('.mytube-local.json', { extensionId: 'a'.repeat(32) });
    assert.equal(await launchMode(root), 'start');
    await write('dist/brave/manifest.json', { version: '0.9.0' });
    assert.equal(await launchMode(root), 'update');
    await write('dist/brave/manifest.json', { version: '1.0.0' });
    await write('node_modules/example/package.json', { version: '1.0.0' });
    assert.equal(await launchMode(root), 'update');
    await write('node_modules/example/package.json', { version: '2.0.0' });
    await rm(new URL('dist/brave/live.js', root));
    assert.equal(await launchMode(root), 'update');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
