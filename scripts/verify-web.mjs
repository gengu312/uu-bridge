import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, timeout: 10_000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('本地网页主控请求超时。')));
  });
}

const portal = await get('http://127.0.0.1:18787/web-controller');
assert.equal(portal.status, 303);
const loginUrl = new URL(portal.headers.location);
assert.equal(loginUrl.origin, 'http://127.0.0.1:18789');
const navigation = { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate' };
const bootstrap = await get(loginUrl, navigation);
assert.equal(bootstrap.status, 303);
const cookie = bootstrap.headers['set-cookie'][0].split(';')[0];
const login = await get('http://127.0.0.1:18789/login', { ...navigation, Cookie: cookie });
assert.equal(login.status, 200);
assert.ok(login.body.toString().includes('<html'));
const sameOrigin = { Cookie: cookie, Origin: 'http://127.0.0.1:18789', 'Sec-Fetch-Site': 'same-origin' };
const health = await get('http://127.0.0.1:18789/api/health', sameOrigin);
assert.equal(health.status, 200);
assert.equal(JSON.parse(health.body).ok, true);
assert.equal((await get('http://127.0.0.1:18789/login')).status, 403);
assert.equal((await get('http://127.0.0.1:18789/api/health', { ...sameOrigin, Origin: 'https://example.org' })).status, 403);
assert.equal((await get('http://127.0.0.1:18789/login', { ...navigation, Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
assert.equal((await get('http://127.0.0.1:18789/login', { ...navigation, Cookie: cookie, 'Sec-Fetch-Mode': 'cors' })).status, 403);
assert.equal((await get('http://127.0.0.1:18789/api/health', { ...sameOrigin, Host: 'example.org' })).status, 403);
const agentCap = await get('http://127.0.0.1:18789/__uubridge/agent/capabilities', sameOrigin);
assert.equal(agentCap.status, 200);
assert.equal(JSON.parse(agentCap.body).agent_bridge, true);
assert.equal((await get('http://127.0.0.1:18789/__uubridge/agent/capabilities')).status, 403);
assert.equal((await get('http://127.0.0.1:18789/__uubridge/mcp/sessions', sameOrigin)).status, 401);
const assets = [...login.body.toString().matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)].map(match => match[1]);
assert.ok(assets.length > 0);
for (const asset of assets) {
  const response = await get(new URL(asset, 'http://127.0.0.1:18789'), sameOrigin);
  assert.equal(response.status, 200);
  assert.ok(response.body.length > 0);
}
const report = { portalRedirect: true, crossPortLoginNavigation: true, loginPage: true, health: true,
  agentBridgeCapabilities: true, agentAuthIsolated: true,
  unauthenticatedRejected: true, wrongOriginRejected: true, crossSiteRejected: true, crossPortFetchRejected: true,
  wrongHostRejected: true, assets: assets.length, uuLogin: 'not performed', remoteControl: 'not verified' };
await mkdir('output', { recursive: true });
await writeFile('output/web-local-checks.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
