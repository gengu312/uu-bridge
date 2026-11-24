import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const executable = path.join(root, '.build/UU Bridge.app/Contents/MacOS/UUBridge');

class NativeClient {
  pending = new Map();
  sequence = 0;
  buffer = '';

  constructor() {
    // Ctrl+C reaches Node first; the helper must stay alive long enough to release input.
    this.process = spawn(executable, [], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.on('data', () => {});
    this.process.stdout.on('data', data => {
      this.buffer += data;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        } else pending.resolve(message.result);
      }
    });
    this.process.on('error', () => this.fail());
    this.process.on('exit', () => this.fail());
    this.process.stdin.on('error', () => this.fail());
  }

  fail() {
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(Object.assign(new Error('原生桥接程序已退出，请重新启动服务。'), { code: 'NATIVE_UNAVAILABLE' }));
    }
    this.pending.clear();
  }

  request(command, input = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error('原生桥接程序不可用。'), { code: 'NATIVE_UNAVAILABLE' }));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('原生操作超时，请检查系统权限和目标窗口。'), { code: 'NATIVE_TIMEOUT' }));
      }, command === 'permissions' ? 120_000 : 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ ...input, id, command }) + '\n');
    });
  }

  async close() {
    if (!this.closed) {
      // Give the target its mouse-up before terminating the native event source.
      await Promise.race([this.request('release').catch(() => {}), new Promise(resolve => setTimeout(resolve, 500))]);
    }
    if (!this.closed) this.process.kill('SIGTERM');
    this.fail();
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const type = req.headers['content-type']?.split(';')[0];
  if (type !== 'application/json') throw Object.assign(new Error('需要 application/json 请求。'), { status: 415 });
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32_768) throw Object.assign(new Error('请求内容过大。'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error('无效的 JSON。'), { status: 400 }); }
}

function validToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateInput(input) {
  validateTarget(input);
  const types = ['click', 'pointerdown', 'pointerup', 'move', 'scroll', 'key', 'text'];
  if (!types.includes(input.type)) throw Object.assign(new Error('无效的输入类型。'), { status: 400 });
  if (['click', 'pointerdown', 'pointerup', 'move', 'scroll'].includes(input.type)) {
    if (![input.x, input.y].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) {
      throw Object.assign(new Error('坐标必须是 0–1 范围内的数字。'), { status: 400 });
    }
    if (input.button !== undefined && !['left', 'right', 'middle'].includes(input.button)) {
      throw Object.assign(new Error('无效的鼠标按钮。'), { status: 400 });
    }
  }
  if (input.type === 'text' && (typeof input.text !== 'string' || !input.text.length || input.text.length > 4096)) {
    throw Object.assign(new Error('文字长度应为 1–4096。'), { status: 400 });
  }
  if (input.type === 'key' && (typeof input.key !== 'string' || input.key.length > 32 || !input.key.length)) {
    throw Object.assign(new Error('无效的按键。'), { status: 400 });
  }
  if (input.modifiers !== undefined && (!Array.isArray(input.modifiers) || input.modifiers.some(m => !['meta', 'ctrl', 'alt', 'shift'].includes(m)))) {
    throw Object.assign(new Error('无效的修饰键。'), { status: 400 });
  }
  for (const key of ['deltaX', 'deltaY']) {
    if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || Math.abs(input[key]) > 2000)) {
      throw Object.assign(new Error('滚动量超出范围。'), { status: 400 });
    }
  }
  if (input.clickCount !== undefined && ![1, 2].includes(input.clickCount)) {
    throw Object.assign(new Error('无效的点击次数。'), { status: 400 });
  }
  return input;
}

function validateTarget(input) {
  if (!Number.isInteger(input.windowId) || input.windowId <= 0 || input.windowId > 0xffffffff ||
      !Number.isSafeInteger(input.selectionVersion) || input.selectionVersion <= 0) {
    throw Object.assign(new Error('请携带当前窗口 ID 和选择版本。'), { status: 400 });
  }
}

export async function createBridgeServer({ native, port = 18787 } = {}) {
  const ownsNative = !native;
  if (!native) {
    await access(executable).catch(() => { throw new Error('请先运行 npm run build 构建 macOS 桥接程序。'); });
    native = new NativeClient();
  }
  const token = randomBytes(32).toString('hex');
  let actionQueue = Promise.resolve();
  const action = (command, body) => {
    const next = actionQueue.catch(() => {}).then(() => native.request(command, body));
    actionQueue = next;
    return next;
  };
  const captures = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const activePort = server.address()?.port;
    const hosts = [`127.0.0.1:${activePort}`, `localhost:${activePort}`];
    const origins = hosts.map(host => `http://${host}`);
    if (!hosts.includes(req.headers.host) ||
        (req.headers.origin && !origins.includes(req.headers.origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: '只接受本机页面的请求。', code: 'ORIGIN_REJECTED' });
      return;
    }
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (url.pathname === '/web-controller' && req.method === 'GET') {
        let entry;
        try {
          entry = JSON.parse(await readFile(path.join(root, 'output', 'uu-web-local-access.json'), 'utf8'));
        } catch {
          json(res, 503, { error: '本地 UU 网页主控尚未启动，请运行 npm run start:web。' });
          return;
        }
        const destination = new URL(entry.loginUrl);
        if (destination.origin !== 'http://127.0.0.1:18789') throw new Error('本地网页主控入口无效。');
        res.writeHead(303, { Location: destination.href });
        res.end();
        return;
      }
      if (url.pathname === '/api/session' && req.method === 'GET') {
        json(res, 200, { token, mcpEntry: path.join(root, 'agent', 'mcp-server.mjs') });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!validToken(req.headers['x-uubridge-token'], token)) {
          json(res, 401, { error: '会话已过期，请刷新页面。', code: 'UNAUTHORIZED' });
          return;
        }
        if (req.method === 'GET') {
          const commands = { '/api/status': 'status', '/api/windows': 'windows', '/api/test-state': 'test-state' };
          if (commands[url.pathname]) {
            json(res, 200, await native.request(commands[url.pathname]));
            return;
          }
          if (url.pathname === '/api/frame') {
            const target = { windowId: Number(url.searchParams.get('windowId')), selectionVersion: Number(url.searchParams.get('selectionVersion')) };
            validateTarget(target);
            const key = `${target.windowId}:${target.selectionVersion}`;
            // Only share screenshots belonging to the exact same selection.
            if (!captures.has(key)) captures.set(key, native.request('frame', target).finally(() => { captures.delete(key); }));
            const frame = await captures.get(key);
            const image = Buffer.from(frame.jpeg, 'base64');
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length,
              'X-Frame-Width': String(frame.width), 'X-Frame-Height': String(frame.height),
              'X-Frame-Source': frame.source ?? 'unknown', 'X-Window-Id': String(frame.windowId),
              'X-Selection-Version': String(frame.selectionVersion) });
            res.end(image);
            return;
          }
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const commands = { '/api/select': 'select', '/api/input': 'input', '/api/release': 'release',
            '/api/permissions': 'permissions', '/api/open-uu': 'open-uu', '/api/test-window': 'test-window' };
          const command = commands[url.pathname];
          if (command) {
            if (command === 'input') validateInput(body);
            if (command === 'release') validateTarget(body);
            if (command === 'select' && (!Number.isInteger(body.windowId) || body.windowId <= 0 || body.windowId > 0xffffffff)) {
              throw Object.assign(new Error('无效的窗口 ID。'), { status: 400 });
            }
            if (command === 'permissions' && !['screen', 'accessibility'].includes(body.kind)) {
              throw Object.assign(new Error('无效的权限类型。'), { status: 400 });
            }
            // Use an allowlist so payload fields never become arbitrary native commands.
            json(res, 200, await action(command, body));
            return;
          }
        }
        json(res, 404, { error: '接口不存在。', code: 'NOT_FOUND' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: '不支持的请求方法。' });
        return;
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      const file = files[url.pathname];
      if (!file) { json(res, 404, { error: '页面不存在。' }); return; }
      const bytes = await readFile(path.join(root, 'public', file[0]));
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const status = error.status ?? (['SCREEN_PERMISSION', 'ACCESSIBILITY_PERMISSION'].includes(error.code) ? 403 :
        ['NO_WINDOW', 'WINDOW_GONE', 'SELECTION_CHANGED', 'UU_INPUT_UNSUPPORTED'].includes(error.code) ? 409 : error.code === 'NATIVE_UNAVAILABLE' ? 503 : 500);
      json(res, status, { error: error.message, code: error.code ?? 'REQUEST_FAILED' });
    }
  });
  server.on('close', () => { if (ownsNative) native.close(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(error => { if (ownsNative) native.close(); throw error; });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT ?? 18787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 范围内。');
    const server = await createBridgeServer({ port });
    console.log(`UU Bridge → http://127.0.0.1:${server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { server.close(); server.closeAllConnections(); });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
