import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('built CSS and JavaScript match CSP after HTML newline normalization', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  for (const [tag, directive] of [['style', 'style-src'], ['script', 'script-src']]) {
    const raw = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
    // Simulate HTML preprocessing, independently of the build helper.
    const parsedText = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const hash = createHash('sha256').update(parsedText).digest('base64');
    assert.ok(policy.includes(`${directive} 'sha256-${hash}'`), `${tag} would be blocked`);
    assert.ok(!raw.startsWith('\uFEFF'));
  }
  assert.ok(policy.includes("connect-src 'none'"));
  assert.ok(!policy.includes("'unsafe-inline'"));
});
