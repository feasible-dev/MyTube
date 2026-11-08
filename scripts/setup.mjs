import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error('Could not start setup. Install Node.js 22 or newer.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Setup stopped. Fix the error above, then run npm run setup again.')));
  });
}
try {
  if (process.platform !== 'win32') throw new Error('This setup currently supports Windows. See agents.markdown for details.');
  console.log('Installing MyTube...');
  await run('cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund']);
  await run(process.execPath, ['extension/build.mjs']);
  console.log('Connect YouTube in the window that opens. It includes instructions for getting a key.');
  await run(process.execPath, ['connector/windows-key.mjs']);
  console.log('Next: chrome://extensions > Developer mode > Load unpacked > ' + fileURLToPath(new URL('../dist/brave', import.meta.url)));
  console.log('Then run npm start. It asks for the extension ID once and remembers it.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
