import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorOrigin, setupIdentity } from './connector-origin.mjs';
import { startConnector } from '../connector/server.mjs';
import { request } from 'node:http';

const origin = 'moz-extension://12345678-1234-4123-8123-123456789abc';
test('Firefox setup uses the profile origin rather than the public add-on ID', () => {
  assert.equal(setupIdentity({ runtime: { id: 'mytube-local-preview@mytube.invalid', getManifest: () => ({ browser_specific_settings: { gecko: {} } }), getURL: () => origin + '/' } }), origin);
  assert.equal(connectorOrigin('a'.repeat(32)), 'chrome-extension://' + 'a'.repeat(32));
  for (const invalid of ['*', 'null', origin + '/', origin + '/index.html', origin + '?x', origin + ':80', origin.replace('moz-', ''), 'moz-extension://mytube-local-preview@mytube.invalid', origin.replace('://', '://user@'), origin + '\n', undefined]) {
    assert.throws(() => connectorOrigin(invalid), /INVALID_EXTENSION_ID/);
  }
});
test('Firefox loopback allows only the configured origin for preflight, status and connection', async () => {
  let connections = 0;
  const server = await startConnector({ port: 0, extensionId: origin, signOut: async () => {},
    connect: async () => { connections++; }, youtube: { configured: async () => true } });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1', 'X-MyTube-Request': crypto.randomUUID() };
  try {
    for (const path of ['/connect', '/interpret', '/youtube/status']) {
      const response = await fetch(base + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    for (const bad of [origin.replace('12345678', '87654321'), 'null', 'https://example.com', 'chrome-extension://' + 'a'.repeat(32)]) {
      const response = await fetch(base + '/connect', { method: 'POST', headers: { ...headers, Origin: bad }, body: '{}' });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    const absent = { ...headers }; delete absent.Origin;
    assert.equal((await fetch(base + '/connect', { method: 'POST', headers: absent, body: '{}' })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const req = request(base + '/connect', { method: 'POST', headers: { ...headers, Host: 'localhost:' + server.port } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(wrongHost, 403);
    assert.deepEqual(await (await fetch(base + '/youtube/status', { method: 'POST', headers, body: '{}' })).json(), { configured: true });
    assert.deepEqual(await (await fetch(base + '/connect', { method: 'POST', headers, body: '{}' })).json(), { connected: true });
    assert.equal(connections, 1);
  } finally { await server.close(); }
});
