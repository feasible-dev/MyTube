import { open, lstat } from 'node:fs/promises';
import { loadWindowsKey } from './windows-key.mjs';

const defaultPath = new URL('../.secrets', import.meta.url);
const invalid = () => { throw new Error('YOUTUBE_KEY_INVALID'); };
function validateKey(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(value)) invalid();
  return value;
}

// Runtime only. Never called by builders, test discovery or diagnostic scripts.
// Do not populate process.env: child processes must not inherit file secrets.
export async function loadYouTubeKey({ env = process.env, path = defaultPath, protectedKey = path === defaultPath ? loadWindowsKey : async () => null } = {}) {
  if (Object.hasOwn(env, 'MYTUBE_YOUTUBE_API_KEY')) return validateKey(env.MYTUBE_YOUTUBE_API_KEY);
  const protectedValue = await protectedKey();
  if (protectedValue !== null) return validateKey(protectedValue);
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) invalid();
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(8193);
    let size = 0, count;
    do { ({ bytesRead: count } = await handle.read(buffer, size, buffer.length - size, null)); size += count; }
    while (count && size < buffer.length);
    if (size > 8192) invalid();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    let found = false, value;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^MYTUBE_YOUTUBE_API_KEY\s*=\s*([A-Za-z0-9_-]*)$/.exec(line);
      if (!match || found) invalid();
      found = true; value = match[1];
    }
    buffer.fill(0);
    return validateKey(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('YOUTUBE_KEY_INVALID');
  } finally { await handle?.close(); }
}
