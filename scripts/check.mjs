import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const scope = process.argv[2] ?? 'all';
if (!['all', 'extension', 'product'].includes(scope) || process.argv.length > 3) throw new Error('Usage: node scripts/check.mjs [all|extension|product]');
const reportPath = new URL('results/extension-build.json', root);
const extensionTests = ['scripts/browser-bundle.test.mjs', 'poc/build.test.mjs', 'poc/model.test.mjs', 'poc/legacy-model.test.mjs', 'extension/extension.test.mjs', 'extension/youtube-live.test.mjs', 'extension/ui.test.mjs', 'extension/legacy-ui.test.mjs'];

async function findTests(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await findTests(path));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path);
  }
  return files.sort();
}

function run(args, summary) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: fileURLToPath(root), shell: false,
      stdio: ['ignore', summary ? 'pipe' : 'inherit', 'inherit'] });
    let pending = '', diagnostics = '';
    if (summary) child.stdout.setEncoding('utf8').on('data', chunk => {
      diagnostics = (diagnostics + chunk).slice(-65536);
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/.exec(line);
        if (match) summary[match[1]] = Number(match[2]);
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (summary && (code !== 0 || signal)) process.stderr.write(diagnostics);
      resolve(signal ? 1 : code ?? 1);
    });
  });
}

// A successful rebuild resets any prior validation. Never infer a live test or
// claim a check passed from a stale report or hand-maintained test count.
try {
  const previous = JSON.parse(await readFile(reportPath, 'utf8'));
  previous.status = 'BUILD_IN_PROGRESS'; delete previous.validation;
  await writeFile(reportPath, JSON.stringify(previous, null, 2) + '\n');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if ((scope !== 'product' && await run(['poc/build.mjs'])) || await run(['extension/build.mjs'])) {
  await writeFile(reportPath, JSON.stringify({ status: 'BUILD_FAILED', recorded_at: new Date().toISOString() }, null, 2) + '\n');
  process.exitCode = 1;
}
else {
  const evidence = JSON.parse(await readFile(reportPath, 'utf8'));
  const files = scope === 'extension' ? extensionTests
    : (await Promise.all((scope === 'product' ? ['poc', 'extension', 'connector', 'scripts'] : ['poc', 'extension', 'connector', 'spikes', 'scripts']).map(findTests))).flat()
      .filter(file => scope !== 'product' || !['poc/build.test.mjs', 'poc/legacy-model.test.mjs', 'extension/legacy-ui.test.mjs'].includes(file)).sort();
  const summary = {};
  let exitCode = 1, artifactsMatch = false;
  try {
    exitCode = await run(['--test', '--test-reporter=tap', ...files], summary);
    for (const target of Object.values(evidence.targets)) {
      for (const [name, expected] of Object.entries(target.files_sha256)) {
        const bytes = await readFile(new URL(`${target.path}/${name}`, root));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
      }
    }
    artifactsMatch = true;
  } catch { console.error('Verification could not complete or built artifacts changed.'); }
  const passed = exitCode === 0 && artifactsMatch && summary.tests > 0 && summary.pass === summary.tests
    && ['fail', 'cancelled', 'skipped', 'todo'].every(key => summary[key] === 0);
  evidence.status = passed ? 'BUILT_OFFLINE_CHECKS_PASSED' : 'BUILT_OFFLINE_CHECKS_FAILED';
  evidence.validation = { scope, test_files: files, ...summary, exit_code: exitCode,
    artifact_hashes_verified: artifactsMatch, recorded_at: new Date().toISOString(),
    real_browser_visual_verified: false, real_provider_quality_verified: false };
  await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(passed ? `${summary.pass}/${summary.tests} offline checks passed (${scope}); artifact hashes verified.` : 'Offline verification failed.');
  if (!passed) process.exitCode = 1;
}
