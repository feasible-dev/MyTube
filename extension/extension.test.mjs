import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { readClientId, liveManifestSettings } from './live-config.mjs';
const root = new URL('../', import.meta.url);

for (const target of ['brave', 'firefox']) test(`${target} package has bounded permissions, packaged code, and matching CSP`, async () => {
  const dir = new URL(`dist/${target}/`, root);
  assert.deepEqual((await readdir(dir)).sort(), ['app.js', 'background.js', 'index.html', 'live.js', 'manifest.json', 'style.css']);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  let clientId = null;
  try { clientId = readClientId(JSON.parse(await readFile(new URL('extension/google-client.json', root), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expected = liveManifestSettings(clientId, target);
  assert.deepEqual(manifest.permissions, expected.additions.permissions);
  assert.deepEqual(manifest.host_permissions, expected.additions.host_permissions);
  assert.deepEqual(manifest.oauth2, expected.additions.oauth2);
  for (const key of ['optional_permissions', 'optional_host_permissions', 'content_scripts', 'web_accessible_resources', 'externally_connectable']) assert.equal(manifest[key], undefined);
  const policy = manifest.content_security_policy.extension_pages;
  assert.equal(policy, expected.policy);
  assert.ok(!/unsafe-/.test(policy));
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.ok(!/<script(?! src=)|<style>|\son\w+=/i.test(html));
  assert.ok(html.includes('<script src="app.js" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="style.css">'));
  const script = await readFile(new URL('app.js', dir), 'utf8');
  new vm.Script(script);
  new vm.Script(await readFile(new URL('live.js', dir), 'utf8'));
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|eval)\s*\(/.test(script));
  if (target === 'brave') assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  else {
    assert.deepEqual(manifest.background, { scripts: ['background.js'] });
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
  }
});

test('normal Chromium discovery works without Google OAuth; identity is reserved for subscriptions', () => {
  const id = '123-example.apps.googleusercontent.com';
  assert.equal(readClientId({ client_id: id }), id);
  assert.equal(readClientId({ client_id: null }), null);
  assert.throws(() => readClientId({ client_id: id, client_secret: 'not-allowed' }));
  assert.throws(() => readClientId({ client_id: 'https://host.example' }));
  const clean = liveManifestSettings(null, 'brave');
  assert.equal(clean.additions.permissions, undefined);
  assert.equal(clean.additions.oauth2, undefined);
  assert.ok(clean.additions.host_permissions.includes('http://127.0.0.1/*'));
  assert.ok(clean.policy.includes('http://127.0.0.1:43817'));
  assert.ok(clean.policy.includes('https://i.ytimg.com'));
  assert.deepEqual(liveManifestSettings(id, 'firefox').additions, {});
  const { additions, policy } = liveManifestSettings(id, 'brave');
  assert.deepEqual(additions.permissions, ['identity']);
  assert.deepEqual(additions.host_permissions, ['https://www.googleapis.com/*', 'http://127.0.0.1/*', 'https://vimeo.com/*', 'https://www.dailymotion.com/*', 'https://api.dailymotion.com/*', 'https://rutube.ru/*', 'https://rumble.com/*', 'https://www.bitchute.com/*', 'https://odysee.com/*', 'https://archive.org/*']);
  assert.deepEqual(additions.oauth2.scopes, ['https://www.googleapis.com/auth/youtube.readonly']);
  assert.ok(policy.includes("connect-src https://www.googleapis.com"));
  assert.ok(!policy.includes('accounts.google.com'));
});

test('toolbar opens only its packaged page and does nothing before a click', async () => {
  const source = await readFile(new URL('background.js', import.meta.url), 'utf8');
  for (const namespace of ['chrome', 'browser']) {
    let clicked;
    const urls = [];
    const api = { action: { onClicked: { addListener(fn) { clicked = fn; } } },
      runtime: { getURL(path) { assert.equal(path, 'index.html'); return `extension-test://${path}`; } },
      tabs: { async create({ url }) { urls.push(url); } } };
    vm.runInNewContext(source, { [namespace]: api, console });
    assert.equal(urls.length, 0);
    await clicked();
    assert.deepEqual(urls, ['extension-test://index.html']);
  }
});
