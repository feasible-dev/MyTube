import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const script = fileURLToPath(new URL('../scripts/windows-key.ps1', import.meta.url));
const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const args = mode => ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode];
// Never forward an environment-based API key to the helper process.
function childEnvironment() { const env = { ...process.env }; delete env.MYTUBE_YOUTUBE_API_KEY; return env; }

export async function loadWindowsKey() {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve, reject) => {
    const child = execFile(powershell(), args('Read'), { windowsHide: true, env: childEnvironment(), timeout: 8000, maxBuffer: 16384, encoding: 'utf8' }, (error, stdout) => {
      // Child error objects can contain stdout. Never propagate them.
      if (error || (stdout && !/^[A-Za-z0-9_-]{20,256}$/.test(stdout))) reject(new Error('YOUTUBE_KEY_INVALID'));
      else resolve(stdout || null);
    });
    child.stdin.end();
  });
}

let setupProcess;
export async function openWindowsKeySetup() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_KEY_UNAVAILABLE');
  if (setupProcess) return { opened: true };
  return new Promise((resolve, reject) => {
    const child = spawn(powershell(), args('Setup'), { windowsHide: true, env: childEnvironment(), stdio: 'ignore' });
    setupProcess = child;
    child.once('error', () => { setupProcess = null; reject(new Error('WINDOWS_KEY_UNAVAILABLE')); });
    child.once('exit', () => { setupProcess = null; });
    child.once('spawn', () => resolve({ opened: true }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openWindowsKeySetup().catch(() => { console.error('Windows key setup could not open. Run it in your own Windows account.'); process.exitCode = 1; });
}
