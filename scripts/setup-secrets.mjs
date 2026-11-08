import { open, lstat, chmod } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostname } from 'node:os';

const defaultPath = new URL('../.secrets', import.meta.url);
export function parseSetupIdentity(who) {
  const sid = who.match(/S-1-5-[0-9-]+/)?.[0];
  if (!sid) throw new Error('SECRET_IDENTITY_FAILED');
  return { sid, isolated: /\\CodexSandbox[^",\r\n]*/i.test(who) };
}
export function assertSetupAccount(identity, isRootFile) {
  if (isRootFile && identity.isolated) throw new Error('SECRET_SETUP_WRONG_ACCOUNT');
}
export function setupFailureMessage(code) {
  return ({
    SECRET_SETUP_WRONG_ACCOUNT: 'Run npm.cmd run secrets:edit in your own Windows terminal, not the Codex sandbox. No private file was opened or changed.',
    SECRET_CREATE_FAILED: 'Cannot create or access .secrets. Check its Windows Security permissions for your account. Existing contents were not changed.',
    SECRET_METADATA_FAILED: 'Cannot inspect .secrets file permissions. Your Windows account may not have access. Existing contents were not changed.',
    SECRET_IDENTITY_FAILED: 'Could not identify your Windows account. No private file was opened or changed.',
    SECRET_PERMISSIONS_FAILED: 'Could not grant private-file access to your Windows account. Existing contents were preserved.',
    SECRET_OWNER_FAILED: 'Could not transfer .secrets ownership to your Windows account. Existing contents were preserved.',
  })[code] ?? 'Could not prepare the private file. No contents were displayed.';
}

export async function prepareSecrets(path = defaultPath) {
  let identity;
  if (process.platform === 'win32') {
    try { identity = parseSetupIdentity(execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })); }
    catch { throw new Error('SECRET_IDENTITY_FAILED'); }
    // This check precedes even file creation. Temporary synthetic test files
    // may use the test process identity; the user's real file must never do so.
    assertSetupAccount(identity, fileURLToPath(path).toLowerCase() === fileURLToPath(defaultPath).toLowerCase());
  }
  let created = false;
  try {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile('# Do not, under any circumstance, read the content of this file.\n# Agents: runtime connector access only. Never print or upload this file.\n# Paste your key after =, without quotes. Save the file.\nMYTUBE_YOUTUBE_API_KEY=\n'); created = true; }
    finally { await handle.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw new Error('SECRET_CREATE_FAILED'); }
  let info;
  try { info = await lstat(path); } catch { throw new Error('SECRET_METADATA_FAILED'); }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('SECRET_SETUP_FAILED');
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls.exe', [fileURLToPath(path), '/inheritance:r', '/grant:r', `*${identity.sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'ignore', windowsHide: true });
      execFileSync('icacls.exe', [fileURLToPath(path), '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545'], { stdio: 'ignore', windowsHide: true });
    } catch { throw new Error('SECRET_PERMISSIONS_FAILED'); }
    if (!identity.isolated) {
      try { execFileSync('icacls.exe', [fileURLToPath(path), '/setowner', `*${identity.sid}`], { stdio: 'ignore', windowsHide: true }); }
      catch { throw new Error('SECRET_OWNER_FAILED'); }
      // Clean up grants from earlier agent-created files. Unknown accounts on
      // computers without Codex are harmless; do not require their existence.
      for (const account of ['CodexSandboxOffline', 'CodexSandboxOnline']) {
        try { execFileSync('icacls.exe', [fileURLToPath(path), '/remove:g', `${hostname()}\\${account}`], { stdio: 'ignore', windowsHide: true }); }
        catch { /* The account may not exist on this computer. */ }
      }
    }
  } else await chmod(path, 0o600);
  return { created };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = defaultPath;
  try {
    const { created } = await prepareSecrets(path);
    console.log(created ? 'Local .secrets created; paste your key after MYTUBE_YOUTUBE_API_KEY=.' : 'Existing .secrets preserved; contents were not read.');
    if (process.argv.includes('--edit') && process.platform === 'win32') {
      // Explicit user command opens their editor; no editor text returns here.
      const editor = spawn('notepad.exe', [fileURLToPath(path)], { detached: true, stdio: 'ignore' });
      editor.on('error', () => console.error('Open .secrets manually in your local text editor.')); editor.unref();
    }
  } catch (error) { console.error(setupFailureMessage(error?.message)); process.exitCode = 1; }
}
