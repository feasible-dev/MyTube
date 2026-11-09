import { readFile } from 'node:fs/promises';
import { normalizeInlineSource } from '../poc/inline-source.mjs';
import { buildBrowserScript } from './browser-bundle.mjs';

export async function buildPageAssets(snapshot) {
  const [css, code] = await Promise.all([
    Promise.all(['style.css', 'theme.css'].map(name => readFile(new URL(`../poc/${name}`, import.meta.url), 'utf8'))).then(parts => parts.join('\n')),
    buildBrowserScript('poc/app.js', snapshot),
  ]);
  return { css: normalizeInlineSource(css), code };
}
