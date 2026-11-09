import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
export async function launchMode(directory = root) {
  const pkg = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
  let previouslyConfigured = false;
  try { await access(new URL('.mytube-local.json', directory)); previouslyConfigured = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const install = previouslyConfigured ? 'update' : 'setup';
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    try {
      const dependency = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, directory), 'utf8'));
      if (dependency.version !== version) return install;
    } catch (error) { if (error.code === 'ENOENT') return install; throw error; }
  }
  try {
    const manifest = JSON.parse(await readFile(new URL('dist/brave/manifest.json', directory), 'utf8'));
    if (manifest.version !== pkg.version) return install;
    for (const file of ['app.js', 'live.js', 'background.js', 'index.html', 'style.css']) await access(new URL(`dist/brave/${file}`, directory));
  } catch (error) { if (error.code === 'ENOENT') return install; throw error; }
  // A prebuilt download still needs its first-time key/setup guidance.
  return previouslyConfigured ? 'start' : 'setup';
}

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: fileURLToPath(root), stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error('Could not start MyTube.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The previous step did not finish. Reopen MyTube.cmd to retry.')));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Windows with Node.js 22 or newer: https://nodejs.org/');
    const mode = await launchMode();
    if (mode !== 'start') await run('scripts/setup.mjs', mode === 'update' ? ['--skip-key'] : []);
    if (mode === 'update') console.log('Updated. Reload MyTube in your browser extensions page (Chrome / Edge / Brave), or about:debugging (Firefox), then reopen MyTube.');
    await run('scripts/start.mjs');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
