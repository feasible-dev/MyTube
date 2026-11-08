import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('verification never reports success after test failure, artifact changes or a failed rebuild', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mytube-verification-'));
  try {
    for (const folder of ['scripts', 'poc', 'extension', 'connector', 'spikes', 'results', 'dist']) await mkdir(join(directory, folder));
    await copyFile(new URL('./check.mjs', import.meta.url), join(directory, 'scripts/check.mjs'));
    await writeFile(join(directory, 'extension/build.mjs'), `
      import fs from 'node:fs'; import { createHash } from 'node:crypto';
      fs.writeFileSync('dist/app.js', 'fixture');
      fs.writeFileSync('results/extension-build.json', JSON.stringify({ status: 'BUILT_OFFLINE_CHECKS_PENDING', targets: {
        fixture: { path: 'dist', files_sha256: { 'app.js': createHash('sha256').update('fixture').digest('hex') } }
      } }));`);
    const execute = async (expectedCode, scope = 'all') => {
      let code = 0;
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      try { await promisify(execFile)(process.execPath, ['scripts/check.mjs', scope], { cwd: directory, env }); }
      catch (error) { code = error.code; }
      assert.equal(code, expectedCode);
      return JSON.parse(await readFile(join(directory, 'results/extension-build.json'), 'utf8'));
    };
    await writeFile(join(directory, 'poc/build.mjs'), '');
    const testPath = join(directory, 'poc/fixture.test.mjs');
    await writeFile(testPath, "import test from 'node:test'; test('fixture', () => {});");
    const passed = await execute(0);
    assert.equal(passed.status, 'BUILT_OFFLINE_CHECKS_PASSED');
    assert.equal(passed.validation.tests, 1);
    // Product verification must not depend on the demo build or historical suites.
    await writeFile(join(directory, 'poc/build.mjs'), 'process.exitCode = 1;');
    const historical = ['poc/build.test.mjs', 'poc/legacy-model.test.mjs', 'extension/legacy-ui.test.mjs', 'spikes/historical.test.mjs'];
    for (const file of historical) await writeFile(join(directory, file), "throw Error('Historical fixture must not run');");
    const product = await execute(0, 'product');
    assert.equal(product.validation.scope, 'product');
    assert.deepEqual(product.validation.test_files, ['poc/fixture.test.mjs']);
    assert.equal(product.validation.tests, 1);
    for (const file of historical) await rm(join(directory, file));
    await writeFile(join(directory, 'poc/build.mjs'), '');
    await writeFile(testPath, "import test from 'node:test'; test('fixture', () => { throw Error('expected failure'); });");
    assert.equal((await execute(1)).status, 'BUILT_OFFLINE_CHECKS_FAILED');
    await writeFile(testPath, "import test from 'node:test'; import fs from 'node:fs'; test('fixture', () => { fs.writeFileSync('dist/app.js', 'changed'); });");
    const changed = await execute(1);
    assert.equal(changed.validation.pass, 1);
    assert.equal(changed.validation.artifact_hashes_verified, false);
    await writeFile(join(directory, 'extension/build.mjs'), 'process.exitCode = 1;');
    const failedBuild = await execute(1);
    assert.equal(failedBuild.status, 'BUILD_FAILED');
    assert.equal(failedBuild.validation, undefined);
  } finally {
    const withinTemp = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp) && withinTemp.startsWith('mytube-verification-'));
    await rm(directory, { recursive: true, force: true });
  }
});
