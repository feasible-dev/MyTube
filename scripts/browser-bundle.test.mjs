import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildPageAssets } from './page-assets.mjs';
import { normalizeInlineSource } from '../poc/inline-source.mjs';

test('inline sources handle Windows, Unix, and mixed newlines with a BOM', () => {
  assert.equal(normalizeInlineSource('\uFEFFa\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(normalizeInlineSource('a\nb\n'), 'a\nb\n');
});

test('each page build uses only its supplied snapshot and remains safe to embed in the offline HTML', async () => {
  const first = await buildPageAssets({ preview_version: 'BUNDLE_TEST_FIRST',
    title: '</script><script>throw new Error("injected")</script>' });
  assert.ok(first.code.includes('BUNDLE_TEST_FIRST'));
  assert.ok(!first.code.toLowerCase().includes('</script'));
  assert.doesNotThrow(() => new vm.Script(first.code));
  const second = await buildPageAssets({ preview_version: 'BUNDLE_TEST_SECOND' });
  assert.ok(second.code.includes('BUNDLE_TEST_SECOND'));
  assert.ok(!second.code.includes('BUNDLE_TEST_FIRST'));
  assert.ok(!second.code.includes('injected'));
  assert.doesNotThrow(() => new vm.Script(second.code));
});
