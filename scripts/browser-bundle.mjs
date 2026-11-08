import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { normalizeInlineSource } from '../poc/inline-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildBrowserScript(entry, snapshot) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    platform: 'browser', format: 'iife', target: 'es2022', charset: 'utf8', tsconfigRaw: {},
    banner: { js: '"use strict";' }, logLevel: 'silent',
    plugins: [{ name: 'page-snapshot', setup(builder) {
      builder.onResolve({ filter: /^mytube:snapshot$/ }, () => ({ path: 'snapshot', namespace: 'mytube' }));
      builder.onLoad({ filter: /^snapshot$/, namespace: 'mytube' }, () => ({
        contents: JSON.stringify(snapshot), loader: 'json',
      }));
    } }],
  });
  return normalizeInlineSource(result.outputFiles[0].text);
}
