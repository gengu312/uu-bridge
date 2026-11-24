import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer } from '../server.mjs';

test('local API rejects cross-origin input and validates native commands', async t => {
  const calls = [];
  const native = {
    async request(command, input) {
      calls.push({ command, input });
      if (command === 'status') return { screenCapture: false, accessibility: true };
      if (command === 'frame') throw Object.assign(new Error('需要屏幕录制权限'), { code: 'SCREEN_PERMISSION' });
      if (command === 'input' && input.windowId === 99) throw Object.assign(new Error('UU 后台输入未兼容'), { code: 'UU_INPUT_UNSUPPORTED' });
      return { ok: true };
    }
  };
  const server = await createBridgeServer({ native, port: 0 });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(`${base}/api/session`).then(r => r.json());
  const headers = { 'X-UUBridge-Token': token, 'Content-Type': 'application/json' };

  await t.test('token required for capture and input', async () => {
    assert.equal((await fetch(`${base}/api/frame`)).status, 401);
    assert.equal((await fetch(`${base}/api/input`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal(calls.length, 0);
  });
  await t.test('third-party websites cannot read session tokens', async () => {
    const response = await fetch(`${base}/api/session`, { headers: { Origin: 'https://example.org' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    // fetch controls the Host header; use a raw HTTP client to exercise rebinding.
    const status = await new Promise((resolve, reject) => {
      http.get(`${base}/api/session`, { headers: { Host: `evil.example:${server.address().port}` } }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 403);
  });
  await t.test('normalized coordinates validated before native input', async () => {
    for (const x of [-0.1, 1.1, '0.5', null]) {
      const response = await fetch(`${base}/api/input`, {
        method: 'POST', headers, body: JSON.stringify({ type: 'click', x, y: 0.5, windowId: 10, selectionVersion: 1 })
      });
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, 0);
  });
  await t.test('request payload cannot override native command', async () => {
    const response = await fetch(`${base}/api/input`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'click', x: 0.4, y: 0.5, windowId: 10, selectionVersion: 1, command: 'permissions' })
    });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).command, 'input');
  });
  await t.test('missing screen permission is reported as failure', async () => {
    const response = await fetch(`${base}/api/frame?windowId=10&selectionVersion=1`, { headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'SCREEN_PERMISSION');
  });
  await t.test('native permission status remains visible without capture permission', async () => {
    const response = await fetch(`${base}/api/status`, { headers });
    assert.deepEqual(await response.json(), { screenCapture: false, accessibility: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  await t.test('unsupported UU input is not reported as successful', async () => {
    const response = await fetch(`${base}/api/input`, {
      method: 'POST', headers,
      body: JSON.stringify({ windowId: 99, selectionVersion: 1, type: 'click', x: 0.5, y: 0.5 }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'UU_INPUT_UNSUPPORTED');
  });
});

test('an in-flight frame cannot be reused for a different selection', async t => {
  const frames = new Map();
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let secondStarted;
  const second = new Promise(resolve => { secondStarted = resolve; });
  const native = { request(command, input) {
    assert.equal(command, 'frame');
    return new Promise(resolve => {
      frames.set(input.windowId, () => resolve({ jpeg: Buffer.from('frame').toString('base64'), width: 1, height: 1,
        windowId: input.windowId, selectionVersion: input.selectionVersion }));
      if (input.windowId === 10) started(); else secondStarted();
    });
  } };
  const server = await createBridgeServer({ native, port: 0 });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(`${base}/api/session`).then(r => r.json());
  const headers = { 'X-UUBridge-Token': token };
  const frameA = fetch(`${base}/api/frame?windowId=10&selectionVersion=1`, { headers });
  await firstStarted;
  const frameB = fetch(`${base}/api/frame?windowId=20&selectionVersion=2`, { headers });
  await second;
  frames.get(20)();
  const responseB = await frameB;
  assert.equal(responseB.headers.get('x-window-id'), '20');
  assert.equal(responseB.headers.get('x-selection-version'), '2');
  frames.get(10)();
  const responseA = await frameA;
  assert.equal(responseA.headers.get('x-window-id'), '10');
});
