import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const configPath = new URL('../.mytube-local.json', import.meta.url);
const validId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);
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
  if (!validId(id)) throw new Error('Enter the 32-letter extension ID from chrome://extensions, not an API key.');
  await writeFile(path, JSON.stringify({ extensionId: id }) + '\n', { flag: exists ? 'w' : 'wx', mode: 0o600 });
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const extensionId = await extensionIdForStart({ configure: process.argv.includes('--configure'), ask: async () => {
      if (!process.stdin.isTTY) throw new Error('Run npm start in your own terminal for first-time setup.');
      console.log('Open chrome://extensions, enable Developer mode, and Load unpacked: dist/brave.');
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { return await input.question('Paste the MyTube extension ID (asked only once): '); }
      finally { input.close(); }
    } });
    const { runConnector } = await import('../connector/server.mjs');
    await runConnector(extensionId);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
