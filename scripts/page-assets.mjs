import { readFile } from 'node:fs/promises';
import { normalizeInlineSource } from '../poc/inline-source.mjs';
import { buildBrowserScript } from './browser-bundle.mjs';

export async function buildPageAssets(snapshot) {
  const [css, code] = await Promise.all([
    readFile(new URL('../poc/style.css', import.meta.url), 'utf8'),
    buildBrowserScript('poc/app.js', snapshot),
  ]);
  return { css: normalizeInlineSource(css), code };
}
