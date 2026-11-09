import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { connectorOrigin } from '../extension/connector-origin.mjs';

const configPath = new URL('../.mytube-local.json', import.meta.url);
const validId = value => { try { connectorOrigin(value); return true; } catch { return false; } };
export async function extensionIdForStart({ env = process.env, path = configPath, ask, configure = false } = {}) {
  if (env.MYTUBE_EXTENSION_ID !== undefined) {
    if (!validId(env.MYTUBE_EXTENSION_ID)) throw new Error('Invalid extension ID in MYTUBE_EXTENSION_ID.');
    return env.MYTUBE_EXTENSION_ID;
  }
  let exists = false;
  try {
    const info = await lstat(path); exists = true;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Invalid local setup file.');
    const config = JSON.parse(await readFile(path, 'utf8'));
    if (!validId(config.extensionId) || Object.keys(config).some(k => k !== 'extensionId')) throw new Error('Invalid local setup file.');
    if (!configure) return config.extensionId;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Local setup is invalid. Check .mytube-local.json (extension ID only).'); }
  const id = (await ask()).trim();
  if (!validId(id)) throw new Error('Enter the 32-letter extension ID from Chromium or the exact moz-extension:// address shown in the Firefox welcome guide, not an API key.');
  await writeFile(path, JSON.stringify({ extensionId: id }) + '\n', { flag: exists ? 'w' : 'wx', mode: 0o600 });
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const extensionId = await extensionIdForStart({ configure: process.argv.includes('--configure'), ask: async () => {
      if (!process.stdin.isTTY) throw new Error('Run npm start in your own terminal for first-time setup.');
      console.log('For the visual browser-by-browser guide, double-click Install MyTube.html in this folder.');
      console.log('Chrome: chrome://extensions | Edge: edge://extensions | Brave: brave://extensions. Enable Developer mode, Load unpacked: dist/brave.');
      console.log('Firefox: about:debugging > This Firefox > Load Temporary Add-on > dist/firefox/manifest.json. Copy the connection address from the welcome guide.');
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { return await input.question('Paste the MyTube extension ID or Firefox connection address (asked only once): '); }
      finally { input.close(); }
    } });
    const { runConnector } = await import('../connector/server.mjs');
    await runConnector(extensionId);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
