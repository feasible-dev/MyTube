import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, copyFile, cp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('extension builds and its packages pass checks without experiments, private files, Google config or historical media', async () => {
  // Keep native build-tool execution inside the writable workspace on Windows.
  const workspace = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(workspace, '.mytube-clean-build-'));
  try {
    await copyFile(new URL('../package.json', import.meta.url), join(directory, 'package.json'));
    // Simulate installed build dependencies without network access or private data.
    for (const name of ['esbuild', `@esbuild/${process.platform}-${process.arch}`]) {
      await cp(new URL(`../node_modules/${name}/`, import.meta.url), join(directory, 'node_modules', name), { recursive: true });
    }
    for (const folder of ['extension', 'poc', 'scripts']) {
      await mkdir(join(directory, folder));
      for (const entry of await readdir(new URL(`../${folder}/`, import.meta.url), { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(mjs|js|css|html)$/.test(entry.name) || entry.name.endsWith('.test.mjs') || entry.name === 'index.html') continue;
        await copyFile(new URL(`../${folder}/${entry.name}`, import.meta.url), join(directory, folder, entry.name));
      }
    }
    await promisify(execFile)(process.execPath, ['extension/build.mjs'], { cwd: directory });
    await copyFile(new URL('./extension.test.mjs', import.meta.url), join(directory, 'extension/extension.test.mjs'));
    await promisify(execFile)(process.execPath, ['--test', 'extension/extension.test.mjs'], { cwd: directory });
    const app = await readFile(join(directory, 'dist/brave/app.js'), 'utf8');
    assert.ok(Buffer.byteLength(app) < 200000, 'Historical data must not return to the shipped app');
    assert.ok(!app.includes('data:image/jpeg;base64,'));
    const report = JSON.parse(await readFile(join(directory, 'results/extension-build.json'), 'utf8'));
    assert.equal(report.searchable_video_count, 0);
    assert.equal(report.saved_video_count, 0);
    const manifest = JSON.parse(await readFile(join(directory, 'dist/brave/manifest.json'), 'utf8'));
    assert.equal(manifest.oauth2, undefined);
    assert.equal(manifest.permissions, undefined);
    assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'));
    assert.ok(manifest.content_security_policy.extension_pages.includes('https://vimeo.com'));
  } finally {
    const child = relative(resolve(workspace), resolve(directory));
    assert.ok(child.startsWith('.mytube-clean-build-') && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true });
  }
});
