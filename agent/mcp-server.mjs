import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AgentFailure, PROTOCOL_VERSION, formatFailure } from './protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultAccessPath = path.join(root, 'output', 'uu-web-local-access.json');

export const MCP_SERVER_INFO = Object.freeze({
  name: 'uubridge-mcp',
  version: '0.2.0',
});

export const MCP_INSTRUCTIONS = [
  'Remote computer control through the local UU Web Controller (vendor/uu-web, 127.0.0.1 only).',
  'Never ask the user for UU account passwords, SMS codes, or remote system passwords in chat.',
  'Workflow:',
  '1. Call uu_list_sessions first. If no browser tab or remote device is connected, call uu_open_panel so the user can sign into UU in their local browser, connect the target device, and toggle "允许 Agent 控制" in the bottom-right control bar.',
  '2. Call uu_get_session(wait_ms: 25000) to wait for connection readiness while a task is pending.',
  '3. Before any pointer/keyboard input, call uu_screenshot to obtain an observation_id and PNG image. All pointer coordinates (x, y) in uu_action are pixel coordinates in that returned PNG image.',
  '4. Call uu_action with a unique operation_id and the latest observation_id. Short fixed sequences (1-8 actions, e.g. hotkey + type_text + key_press) reduce round trips when no intermediate visual decision is needed. By default observe_after=true waits briefly for visual change and returns a fresh PNG + observation_id.',
  '5. Respect human authority: CONTROL_DENIED means the user has not enabled Agent control yet; HUMAN_PAUSED means the user paused or took over mouse/keyboard. Never bypass or spam retries when paused.',
  '6. Idempotency: Reuse the same operation_id only to query an identical operation. Never automatically replay an outcome_unknown action with a new operation_id; take a fresh uu_screenshot to inspect actual state first.',
].join(' ');

const POINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number', minimum: 0, description: 'Horizontal pixel coordinate in the referenced observation image.' },
    y: { type: 'number', minimum: 0, description: 'Vertical pixel coordinate in the referenced observation image.' },
  },
};

const BUTTON_SCHEMA = {
  type: 'string',
  enum: ['left', 'right', 'middle', 'back', 'forward'],
  default: 'left',
};

const MODIFIERS_SCHEMA = {
  type: 'array',
  maxItems: 4,
  items: { type: 'string', enum: ['CTRL', 'ALT', 'SHIFT', 'META'] },
};

const SINGLE_ACTION_SCHEMA = {
  type: 'object',
  description:
    'Single remote action: click, double_click, move, mouse_down, mouse_up, scroll, drag, key_press, key_down, key_up, hotkey, or type_text.',
  required: ['type'],
  properties: {
    type: {
      type: 'string',
      enum: [
        'click',
        'double_click',
        'move',
        'mouse_down',
        'mouse_up',
        'scroll',
        'drag',
        'key_press',
        'key_down',
        'key_up',
        'hotkey',
        'type_text',
      ],
    },
    x: { type: 'number', minimum: 0 },
    y: { type: 'number', minimum: 0 },
    button: BUTTON_SCHEMA,
    modifiers: MODIFIERS_SCHEMA,
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    ticks: { type: 'integer', minimum: 1, maximum: 10 },
    path: { type: 'array', minItems: 2, maxItems: 128, items: POINT_SCHEMA },
    duration_ms: { type: 'integer', minimum: 10, maximum: 30000 },
    key: { type: 'string', description: 'Key name such as ENTER, ESCAPE, TAB, BACKSPACE, UP, A-Z, 0-9, F1-F12, CTRL, ALT, SHIFT, META.' },
    keys: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
    text: { type: 'string', minLength: 1, maxLength: 16384 },
  },
};

export const MCP_TOOLS = [
  {
    name: 'uu_open_panel',
    description:
      'Check local UU Web Controller status and optionally open it in the local system browser so the user can sign in, connect a remote device, and grant/pause Agent control. Never request credentials in chat.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        open_browser: {
          type: 'boolean',
          default: false,
          description: 'When true, launch the local system browser to the authenticated local login entry.',
        },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'uu_list_sessions',
    description:
      'List all active UU remote device sessions currently open in the local UU Web Controller browser, including resolution, displays, authorization state, and human pause state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'uu_get_session',
    description:
      'Inspect a specific remote session or wait up to 25000 ms for a connected session to become ready (video stream active). Repeat bounded waits on wait_timed_out while a task is pending.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', description: 'Optional session ID (e.g. uu:<deviceId>). Omit to wait for any ready session.' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 25000, default: 0 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'uu_screenshot',
    description:
      'Capture the remote display directly from the WebRTC video stream as a PNG image with immutable observation metadata (observation_id, generation, geometry_epoch, image_size, source_size, region). Subsequent action coordinates use this returned image pixel space.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        region: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'width', 'height'],
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
            width: { type: 'integer', minimum: 1, maximum: 16384 },
            height: { type: 'integer', minimum: 1, maximum: 16384 },
          },
          description: 'Optional crop rectangle in source video pixels.',
        },
        max_edge: { type: 'integer', minimum: 64, maximum: 2048, default: 1280 },
        after_frame_id: { type: 'integer', minimum: 0 },
        generation: { type: 'integer', minimum: 0 },
        timeout_ms: { type: 'integer', minimum: 0, maximum: 5000, default: 2000 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'uu_action',
    description:
      'Submit a remote mouse/keyboard/text action or a short fixed sequence (1-8 actions) bound to a recent observation_id and idempotent operation_id. Coordinates are in the referenced observation image pixel space. Defaults to observe_after=true, waiting briefly for visual change and returning a fresh PNG screenshot. Human pause or display/resolution change stops execution and releases held inputs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'operation_id', 'observation_id', 'action'],
      properties: {
        session_id: { type: 'string' },
        operation_id: { type: 'string', description: 'Unique idempotency key for this logical action.' },
        observation_id: { type: 'string', description: 'Recent observation_id returned by uu_screenshot, uu_action, or uu_wait.' },
        action: {
          oneOf: [
            SINGLE_ACTION_SCHEMA,
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'actions'],
              properties: {
                type: { type: 'string', enum: ['sequence'] },
                interval_ms: { type: 'integer', minimum: 0, maximum: 500, default: 100 },
                actions: { type: 'array', minItems: 1, maxItems: 8, items: SINGLE_ACTION_SCHEMA },
              },
            },
          ],
        },
        observe_after: { type: 'boolean', default: true },
        wait: {
          type: 'object',
          additionalProperties: false,
          required: ['condition'],
          properties: {
            condition: { type: 'string', enum: ['changed', 'stable'] },
            observation_id: { type: 'string', description: 'Optional pre-action cropped observation to watch.' },
            stable_ms: { type: 'integer', minimum: 100, maximum: 5000, default: 200 },
            timeout_ms: { type: 'integer', minimum: 0, maximum: 5000, default: 1000 },
          },
        },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'uu_wait',
    description:
      'Wait for the region captured by observation_id to visually change or become stable, returning matched/wait_timed_out and a fresh PNG screenshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'observation_id', 'condition'],
      properties: {
        session_id: { type: 'string' },
        observation_id: { type: 'string' },
        condition: { type: 'string', enum: ['changed', 'stable'] },
        stable_ms: { type: 'integer', minimum: 100, maximum: 5000, default: 500 },
        timeout_ms: { type: 'integer', minimum: 0, maximum: 25000, default: 5000 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'uu_release_inputs',
    description:
      'Release all held keys and mouse buttons on the remote session and cancel any in-flight input sequence. Held inputs also expire automatically after 15 seconds without another action.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: { session_id: { type: 'string' } },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'uu_set_control',
    description:
      'Enable or disable Agent input within the user-authorized scope. Cannot override human pause or upgrade an unauthorized observe-only session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'enabled'],
      properties: {
        session_id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'uu_clipboard_get',
    description:
      'Read the remote text clipboard within an authorized control session. Note: active remote clipboard polling over UU protocol is primarily supported on macOS hosts or when the host pushes a clipboard notification.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: { session_id: { type: 'string' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'uu_clipboard_set',
    description:
      'Write UTF-8 text to the remote clipboard via the UU clipboard data channel. Requires control permission and an idempotent operation_id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'operation_id', 'text'],
      properties: {
        session_id: { type: 'string' },
        operation_id: { type: 'string' },
        text: { type: 'string', maxLength: 16384 },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'uu_select_display',
    description:
      'Switch to another remote video stream / display index advertised by the session. Releases held input and invalidates previous observations; take a fresh uu_screenshot before further input.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'display_index'],
      properties: {
        session_id: { type: 'string' },
        display_index: { type: 'integer', minimum: 0, maximum: 63 },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'uu_disconnect',
    description: 'Disconnect the remote UU session cleanly and release any held inputs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: { session_id: { type: 'string' } },
    },
    annotations: { readOnlyHint: false },
  },
];

async function readLocalAccess(accessPath = process.env.UUBRIDGE_ACCESS_FILE || defaultAccessPath) {
  try {
    const raw = await readFile(accessPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.origin || !parsed?.agentToken) {
      throw new Error('missing agentToken');
    }
    const url = new URL(parsed.origin);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('non-loopback origin');
    }
    return parsed;
  } catch {
    throw new AgentFailure(
      'WEB_CONTROLLER_UNAVAILABLE',
      '本地 UU 网页主控未启动或缺少 Agent 通道信息。请先在项目目录运行 npm run start:web。',
      { retryable: true },
    );
  }
}

function httpJsonRequest(baseUrl, method, pathname, token, body, timeoutMs = 35_000) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, baseUrl);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text || '{}');
          } catch {
            reject(new AgentFailure('INTERNAL_ERROR', `本地服务返回了非 JSON 响应 (HTTP ${res.statusCode})。`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }
          const err = parsed?.error ?? {};
          reject(
            new AgentFailure(err.code || 'REQUEST_FAILED', err.message || `请求失败 (HTTP ${res.statusCode})`, {
              retryable: Boolean(err.retryable),
              sideEffectPossible: Boolean(err.side_effect_possible),
              status: res.statusCode,
              reason: err.reason,
              details: err.details,
            }),
          );
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new AgentFailure('TIMEOUT', '连接本地 UU 网页主控超时。', { retryable: true }));
    });
    req.on('error', () => {
      reject(
        new AgentFailure(
          'WEB_CONTROLLER_UNAVAILABLE',
          '无法连接本地 UU 网页主控，请确认 npm run start:web 正在运行。',
          { retryable: true },
        ),
      );
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function openSystemBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, 1_000);
    timer.unref?.();
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function formatToolSuccess(value) {
  const data = structuredClone(value);
  const content = [];
  if (data.mime_type === 'image/png' && typeof data.data === 'string') {
    content.push({ type: 'image', mimeType: 'image/png', data: data.data });
    delete data.data;
  }
  if (data.observation?.mime_type === 'image/png' && typeof data.observation?.data === 'string') {
    content.push({ type: 'image', mimeType: 'image/png', data: data.observation.data });
    delete data.observation.data;
  }
  content.unshift({ type: 'text', text: JSON.stringify(data) });
  return { content, structuredContent: data, isError: false };
}

function formatToolError(error) {
  const payload = { error: formatFailure(error) };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export function createMcpDispatcher({ accessPath, openBrowser = openSystemBrowser } = {}) {
  async function callBroker(method, pathname, body, timeoutMs) {
    const access = await readLocalAccess(accessPath);
    return httpJsonRequest(access.origin, method, pathname, access.agentToken, body, timeoutMs);
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case 'uu_open_panel': {
        const access = await readLocalAccess(accessPath);
        const health = await httpJsonRequest(access.origin, 'GET', '/__uubridge/mcp/health', access.agentToken);
        const portalUrl = 'http://127.0.0.1:18787/web-controller';
        // Never leak the one-time loginToken URL into model context; open it directly only when requested.
        let browserOpened = false;
        if (args?.open_browser === true && access.loginUrl) {
          browserOpened = await openBrowser(access.loginUrl);
        }
        return {
          protocol: PROTOCOL_VERSION,
          web_controller_running: Boolean(health.ok),
          browser_tabs_connected: health.browser_tabs_connected,
          active_sessions: health.active_sessions,
          portal_url: portalUrl,
          web_origin: access.origin,
          browser_opened: browserOpened,
          next_step:
            health.active_sessions > 0
              ? '已有活跃远端会话，可调用 uu_list_sessions 查看并在网页右下角控制条确认「允许 Agent 控制」。'
              : '请在本地浏览器打开 http://127.0.0.1:18787/web-controller（或直接打开本地网页主控）登录 UU 并连接目标设备，随后在右下角控制条开启「允许 Agent 控制」。',
        };
      }
      case 'uu_list_sessions':
        return callBroker('GET', '/__uubridge/mcp/sessions');
      case 'uu_get_session': {
        const qs = new URLSearchParams();
        if (args?.session_id) qs.set('session_id', String(args.session_id));
        if (args?.wait_ms !== undefined) qs.set('wait_ms', String(args.wait_ms));
        const suffix = qs.toString() ? `?${qs.toString()}` : '';
        return callBroker('GET', `/__uubridge/mcp/session${suffix}`, undefined, (Number(args?.wait_ms) || 0) + 10_000);
      }
      case 'uu_screenshot':
        return callBroker('POST', '/__uubridge/mcp/screenshot', args, (Number(args?.timeout_ms) || 2000) + 12_000);
      case 'uu_action':
        return callBroker('POST', '/__uubridge/mcp/action', args, 40_000);
      case 'uu_wait':
        return callBroker('POST', '/__uubridge/mcp/wait', args, (Number(args?.timeout_ms) || 5000) + 12_000);
      case 'uu_release_inputs':
        return callBroker('POST', '/__uubridge/mcp/release-inputs', args);
      case 'uu_set_control':
        return callBroker('POST', '/__uubridge/mcp/control', args);
      case 'uu_clipboard_get':
        return callBroker('POST', '/__uubridge/mcp/clipboard', { session_id: args?.session_id, operation: 'get' });
      case 'uu_clipboard_set':
        return callBroker('POST', '/__uubridge/mcp/clipboard', {
          session_id: args?.session_id,
          operation_id: args?.operation_id,
          text: args?.text,
          operation: 'set',
        });
      case 'uu_select_display':
        return callBroker('POST', '/__uubridge/mcp/display', args);
      case 'uu_disconnect':
        return callBroker('POST', '/__uubridge/mcp/disconnect', args);
      default:
        throw new AgentFailure('NOT_FOUND', `未知工具：${name}`);
    }
  }

  async function handleRpcMessage(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = message;
    // Notifications have no id and expect no response.
    if (id === undefined) return null;

    try {
      switch (method) {
        case 'initialize': {
          const requestedVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: requestedVersion,
              capabilities: { tools: {} },
              serverInfo: MCP_SERVER_INFO,
              instructions: MCP_INSTRUCTIONS,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
        case 'tools/call': {
          const toolName = params?.name;
          const toolArgs = params?.arguments ?? {};
          try {
            const value = await callTool(toolName, toolArgs);
            return { jsonrpc: '2.0', id, result: formatToolSuccess(value) };
          } catch (error) {
            return { jsonrpc: '2.0', id, result: formatToolError(error) };
          }
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  return { handleRpcMessage, callTool };
}

export function startStdioMcpServer(options = {}) {
  const dispatcher = createMcpDispatcher(options);
  let buffer = '';
  process.stdin.setEncoding('utf8');

  const writeResponse = (response) => {
    if (!response) return;
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      void dispatcher.handleRpcMessage(parsed).then(writeResponse);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('UUBridge MCP Server (stdio JSON-RPC 2.0)\nUsage: node agent/mcp-server.mjs\nRequires: npm run start:web');
    process.exit(0);
  }
  startStdioMcpServer();
}
