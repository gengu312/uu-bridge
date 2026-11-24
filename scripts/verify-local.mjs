import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';

const base = `http://127.0.0.1:${process.env.PORT ?? 18787}`;
const { token } = await fetch(`${base}/api/session`).then(r => r.json());
const headers = { 'X-UUBridge-Token': token, 'Content-Type': 'application/json' };
async function api(route, body) {
  const response = await fetch(`${base}/api/${route}`, {
    headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error}`);
  return value;
}

const status = await api('status');
assert.equal(status.accessibility, true, '需要辅助功能权限；本脚本不会自动请求权限。');
const { windowId } = await api('test-window', {});
const first = await api('select', { windowId });
const selected = await api('select', { windowId });
const target = { windowId, selectionVersion: selected.selectionVersion };
const stale = await fetch(`${base}/api/input`, { headers, method: 'POST', body: JSON.stringify({
  windowId, selectionVersion: first.selectionVersion, type: 'click', x: 0.5, y: 0.5,
}) });
assert.equal(stale.status, 409, '旧选择版本必须被拒绝，不能发送到新目标。');
const ownWindow = (await api('windows')).windows.find(window => window.id === windowId);
const before = await api('test-state');
await api('input', { ...target, type: 'click', x: 130 / ownWindow.width, y: (ownWindow.height - 118) / ownWindow.height });
await api('input', { ...target, type: 'click', x: 250 / ownWindow.width, y: (ownWindow.height - 192) / ownWindow.height });
const oldText = (await api('test-state')).text;
// Background macOS menu shortcuts such as Command+A are not reliable.
for (let i = 0; i < oldText.length; i++) await api('input', { ...target, type: 'key', key: 'ArrowRight' });
for (let i = 0; i < oldText.length; i++) await api('input', { ...target, type: 'key', key: 'Backspace' });
await api('input', { ...target, type: 'text', text: 'UU Bridge 本地验证 🙂 123X' });
await api('input', { ...target, type: 'key', key: 'Backspace' });
let after;
for (let attempt = 0; attempt < 5; attempt++) {
  after = await api('test-state');
  if (after.clicks === before.clicks + 1 && after.text === 'UU Bridge 本地验证 🙂 123') break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(after.clicks, before.clicks + 1, '必须检查原生按钮确实响应，而不是只检查接口 ok。');
assert.equal(after.text, 'UU Bridge 本地验证 🙂 123');
const frame = await fetch(`${base}/api/frame?windowId=${windowId}&selectionVersion=${target.selectionVersion}`, { headers });
assert.equal(frame.status, 200);
assert.equal(frame.headers.get('x-frame-source'), 'app-rendered-test');
assert.equal(Number(frame.headers.get('x-window-id')), windowId);
assert.equal(Number(frame.headers.get('x-selection-version')), target.selectionVersion);
await mkdir('output', { recursive: true });
await writeFile('output/local-verification.jpg', Buffer.from(await frame.arrayBuffer()));
// Delay the end of a mouse-down body until after release, exercising page-close ordering.
const lateBody = JSON.stringify({ ...target, type: 'pointerdown', x: 0.2, y: 0.7 });
let lateRequest;
const lateResponse = new Promise((resolve, reject) => {
  lateRequest = http.request(`${base}/api/input`, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(lateBody) } }, response => {
    response.resume();
    resolve(response.statusCode);
  });
  lateRequest.on('error', reject);
  lateRequest.write(lateBody.slice(0, 1));
});
await api('release', target);
lateRequest.end(lateBody.slice(1));
assert.equal(await lateResponse, 409, '释放之后到达的按下事件必须被拒绝。');
const result = { screenCapture: status.screenCapture, accessibility: status.accessibility,
  staleSelectionRejected: true, lateInputAfterReleaseRejected: true, nativeButtonResponded: true, unicodeTextMatched: true, backspaceWorked: true,
  targetStayedBackground: !after.active, frameSource: frame.headers.get('x-frame-source'),
  uuWindowCapture: 'not verified', uuRemoteControl: 'not verified' };
await writeFile('output/local-verification.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
