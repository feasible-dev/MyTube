import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const run = promisify(execFile);
assert.equal(process.platform, 'win32', 'The candidate ZIP command currently supports Windows.');
await run(process.execPath, ['extension/build.mjs', '--distribution'], { cwd: fileURLToPath(root), windowsHide: true });
const evidence = JSON.parse(await readFile(new URL('results/distribution-build.json', root), 'utf8'));
const packages = [];
for (const [browser, target] of Object.entries(evidence.targets)) {
const directory = new URL(`${target.path}/`, root);
const names = Object.keys(target.files_sha256).sort();
assert.deepEqual((await readdir(directory)).sort(), names);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
assert.equal(manifest.oauth2, undefined, 'Distribution must not contain local Google registration.');
assert.equal(manifest.key, undefined, 'Distribution must not pin a developer identity.');
for (const name of names) {
  const file = new URL(name, directory), stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Only regular packaged files are allowed.');
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), target.files_sha256[name]);
}
assert.match(evidence.version, /^\d+\.\d+\.\d+$/);
const label = browser === 'brave' ? 'chrome' : 'firefox';
const archive = new URL(`dist/distribution/mytube-${label}-${evidence.version}.zip`, root);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
// Pass a fixed allowlist as literal paths; never archive the working directory.
const command = `Compress-Archive -LiteralPath @(${names.map(name => quote(fileURLToPath(new URL(name, directory)))).join(',')}) -DestinationPath ${quote(fileURLToPath(archive))} -Force`;
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
packages.push({ browser: label, archive: fileURLToPath(archive), sha256: hash, files: names });
console.log(`Created dist/distribution/mytube-${label}-${evidence.version}.zip (${names.length} allowlisted files). Not published or signed; real-provider installation remains unverified.`);
}
await writeFile(new URL('results/distribution-package.json', root), JSON.stringify({ version: evidence.version,
  packages, published: false, live_provider_installation_verified: false }, null, 2) + '\n');
