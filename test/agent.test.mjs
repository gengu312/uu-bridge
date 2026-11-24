import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentFailure,
  mapObservationPointToSource,
  normalizeKeyName,
  resolveActionPlan,
  validateActionRequest,
  validateScreenshotArgs,
} from '../agent/protocol.mjs';
import { createAgentBroker } from '../agent/broker.mjs';
import { createMcpDispatcher } from '../agent/mcp-server.mjs';
import { startLocalUuWebServer } from '../vendor/uu-web/local-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=';

test('protocol validates key aliases, coordinates, and sequence safety limits', () => {
  assert.deepEqual(normalizeKeyName('cmd'), { name: 'META', code: 117 });
  assert.deepEqual(normalizeKeyName('Return'), { name: 'ENTER', code: 66 });
  assert.deepEqual(normalizeKeyName('arrow-down'), { name: 'DOWN', code: 20 });
  assert.throws(() => normalizeKeyName('NOT_A_KEY'), (err) => err instanceof AgentFailure && err.code === 'INVALID_ARGUMENT');

  // Cropped + scaled observation coordinate mapping back to source video space.
  const obs = {
    source_size: { width: 1920, height: 1080 },
    image_size: { width: 300, height: 200 },
    region: { x: 400, y: 200, width: 600, height: 400 },
  };
  assert.deepEqual(mapObservationPointToSource(obs, 150, 100), {
    absX: 700,
    absY: 400,
    surfaceWidth: 1920,
    surfaceHeight: 1080,
  });
  assert.throws(() => mapObservationPointToSource(obs, 301, 100), (err) => err.code === 'INVALID_ARGUMENT');

  // Sequence rejects nested sequences, held inputs, and excessive duration.
  assert.throws(
    () =>
      validateActionRequest({
        session_id: 'uu:dev1',
        operation_id: 'op1',
        observation_id: 'obs1',
        action: { type: 'sequence', actions: [{ type: 'key_down', key: 'SHIFT' }] },
      }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () =>
      validateActionRequest({
        session_id: 'uu:dev1',
        operation_id: 'op2',
        observation_id: 'obs1',
        action: {
          type: 'sequence',
          actions: [{ type: 'key_press', key: 'A', duration_ms: 9000 }],
        },
      }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => validateScreenshotArgs({ session_id: 'uu:dev1', after_frame_id: 5 }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );

  // Valid sequence resolves all mapped points and keycodes cleanly.
  const parsed = validateActionRequest({
    session_id: 'uu:dev1',
    operation_id: 'op3',
    observation_id: 'obs1',
    action: {
      type: 'sequence',
      interval_ms: 50,
      actions: [
        { type: 'click', x: 150, y: 100 },
        { type: 'hotkey', keys: ['META', 'L'] },
        { type: 'type_text', text: 'https://example.com' },
        { type: 'key_press', key: 'ENTER' },
      ],
    },
  });
  const plan = resolveActionPlan(parsed.action, obs);
  assert.equal(plan.type, 'sequence');
  assert.equal(plan.actions[0].absX, 700);
  assert.equal(plan.actions[0].absY, 400);
  assert.equal(plan.actions[1].keys[0].code, 117);
  assert.equal(plan.actions[3].keyCode, 66);
});

function startTestBrokerServer() {
  let origin = '';
  const broker = createAgentBroker({ getOrigin: () => origin });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/__uubridge/mcp/')) {
      void broker.handleAgentRequest(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/__uubridge/agent/')) {
      void broker.handleBrowserRequest(req, res, url);
      return;
    }
    res.writeHead(404).end();
  });
  server.requestTimeout = 0;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, broker, origin });
    });
  });
}

function connectMockBrowserTab(origin, tabId, onCommand) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}/__uubridge/agent/events?tabId=${encodeURIComponent(tabId)}`, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      let resolved = false;
      const policies = [];
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const rawEvent = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let eventName = 'message';
          let dataLine = '';
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine);
          if (eventName === 'hello' && !resolved) {
            resolved = true;
            resolve({
              policies,
              close: () => req.destroy(),
            });
          } else if (eventName === 'policy') {
            policies.push(payload);
          } else if (eventName === 'command') {
            Promise.resolve()
              .then(() => onCommand(payload))
              .then(async (result) => {
                await fetch(`${origin}/__uubridge/agent/reply`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ request_id: payload.request_id, ok: true, result }),
                });
              })
              .catch(async (error) => {
                await fetch(`${origin}/__uubridge/agent/reply`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    request_id: payload.request_id,
                    ok: false,
                    error: {
                      code: error.code || 'BROWSER_COMMAND_FAILED',
                      message: error.message || String(error),
                      retryable: Boolean(error.retryable),
                      side_effect_possible: Boolean(error.sideEffectPossible),
                    },
                  }),
                });
              });
          }
        }
      });
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}

test('broker + MCP enforce human authority, observation freshness, idempotency, and image blocks', async (t) => {
  const { server, broker, origin } = await startTestBrokerServer();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'uubridge-mcp-test-'));
  const accessPath = path.join(tempDir, 'access.json');
  await writeFile(
    accessPath,
    JSON.stringify({
      origin,
      loginUrl: `${origin}/login?localToken=super-secret-login-token`,
      agentToken: broker.agentToken,
    }),
  );

  const receivedCommands = [];
  let frameCounter = 10;
  let clipboardText = 'initial-remote-clip';
  const mockTab = await connectMockBrowserTab(origin, 'tab_test_1', (cmd) => {
    receivedCommands.push(cmd);
    if (cmd.method === 'screenshot') {
      frameCounter += 1;
      return {
        display_index: 0,
        source_size: { width: 1920, height: 1080 },
        image_size: { width: 960, height: 540 },
        region: cmd.params.region ?? { x: 0, y: 0, width: 1920, height: 1080 },
        frame_id: frameCounter,
        snapshot_id: `snap_${frameCounter}`,
        png_base64: TINY_PNG_BASE64,
      };
    }
    if (cmd.method === 'action') {
      frameCounter += 1;
      return {
        status: 'submitted',
        has_held_inputs: cmd.params.plan.type === 'key_down',
        after_frame_id: frameCounter,
        wait_result: cmd.params.observe_after ? { matched: true, elapsed_ms: 42 } : undefined,
        screenshot: cmd.params.observe_after
          ? {
              display_index: 0,
              source_size: { width: 1920, height: 1080 },
              image_size: { width: 960, height: 540 },
              region: { x: 0, y: 0, width: 1920, height: 1080 },
              frame_id: frameCounter,
              snapshot_id: `snap_${frameCounter}`,
              png_base64: TINY_PNG_BASE64,
            }
          : undefined,
      };
    }
    if (cmd.method === 'wait') {
      frameCounter += 1;
      return {
        matched: true,
        elapsed_ms: 120,
        screenshot: {
          display_index: 0,
          source_size: { width: 1920, height: 1080 },
          image_size: { width: 960, height: 540 },
          region: cmd.params.region,
          frame_id: frameCounter,
          snapshot_id: `snap_${frameCounter}`,
          png_base64: TINY_PNG_BASE64,
        },
      };
    }
    if (cmd.method === 'clipboard_set') {
      clipboardText = cmd.params.text;
      return { applied: true };
    }
    if (cmd.method === 'clipboard_get') {
      return { text: clipboardText, source: 'remote' };
    }
    if (cmd.method === 'select_display') {
      return { active_display_index: cmd.params.display_index, source_size: { width: 2560, height: 1440 } };
    }
    if (cmd.method === 'release_inputs' || cmd.method === 'cancel_and_release') {
      return { released: true, has_held_inputs: false };
    }
    if (cmd.method === 'disconnect') {
      return { disconnected: true };
    }
    throw new Error(`unexpected ${cmd.method}`);
  });

  t.after(async () => {
    mockTab.close();
    broker.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  // Report one connected UU remote device from the mock browser tab.
  const reportState = async (override = {}) => {
    const res = await fetch(`${origin}/__uubridge/agent/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tab_id: 'tab_test_1',
        sessions: [
          {
            device_id: 'dev42',
            device_name: 'Alice-Mac',
            stage: 'connected',
            target_platform: 4,
            source_size: { width: 1920, height: 1080 },
            displays: [
              { index: 0, id: 'v0', width: 1920, height: 1080, active: true },
              { index: 1, id: 'v1', width: 2560, height: 1440, active: false },
            ],
            active_display_index: 0,
            frame_id: frameCounter,
            video_ready: true,
            video_stalled: false,
            control_channel_open: true,
            text_channel_open: true,
            file_channel_open: true,
            session_instance_id: 'inst_1',
            ...override,
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
  };
  await reportState();

  // Security check: MCP endpoints require exact Bearer token and reject cross-site origin.
  assert.equal((await fetch(`${origin}/__uubridge/mcp/sessions`)).status, 401);
  assert.equal(
    (
      await fetch(`${origin}/__uubridge/mcp/sessions`, {
        headers: { Authorization: `Bearer ${broker.agentToken}`, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );

  const mcp = createMcpDispatcher({ accessPath, openBrowser: async () => true });

  // MCP initialize + tools/list
  const initResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  });
  assert.equal(initResp.result.serverInfo.name, 'uubridge-mcp');
  const listTools = await mcp.handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(listTools.result.tools.some((tool) => tool.name === 'uu_action'));

  // uu_open_panel must never leak loginToken or agentToken into model output.
  const panelResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'uu_open_panel', arguments: { open_browser: false } },
  });
  const panelText = JSON.stringify(panelResp.result);
  assert.equal(panelResp.result.isError, false);
  assert.ok(!panelText.includes('super-secret-login-token'));
  assert.ok(!panelText.includes(broker.agentToken));

  // Screenshot works in observe-only mode and returns separate text + PNG image blocks.
  const shotResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'uu_screenshot', arguments: { session_id: 'uu:dev42' } },
  });
  assert.equal(shotResp.result.isError, false);
  assert.equal(shotResp.result.content.length, 2);
  assert.equal(shotResp.result.content[1].type, 'image');
  assert.equal(shotResp.result.content[1].data, TINY_PNG_BASE64);
  const obs1 = shotResp.result.structuredContent.observation_id;
  assert.ok(obs1.startsWith('obs_'));
  assert.equal(shotResp.result.structuredContent.data, undefined);

  // Action must be rejected before human explicitly authorizes Agent control.
  const deniedResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'uu_action',
      arguments: {
        session_id: 'uu:dev42',
        operation_id: 'op_denied',
        observation_id: obs1,
        action: { type: 'click', x: 480, y: 270 },
      },
    },
  });
  assert.equal(deniedResp.result.isError, true);
  assert.equal(deniedResp.result.structuredContent.error.code, 'CONTROL_DENIED');

  // Agent cannot self-authorize via uu_set_control.
  const selfAuth = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'uu_set_control', arguments: { session_id: 'uu:dev42', enabled: true } },
  });
  assert.equal(selfAuth.result.isError, true);
  assert.equal(selfAuth.result.structuredContent.error.code, 'CONTROL_DENIED');

  // Human clicks "允许 Agent 控制" in browser bar.
  const authRes = await fetch(`${origin}/__uubridge/agent/viewer-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'uu:dev42', operation: 'authorize' }),
  });
  assert.equal(authRes.status, 200);

  // Action now succeeds, maps coordinates (480/960*1920 = 960, 270/540*1080 = 540), and returns fresh observation image.
  const actResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'uu_action',
      arguments: {
        session_id: 'uu:dev42',
        operation_id: 'op_click_1',
        observation_id: obs1,
        action: { type: 'click', x: 480, y: 270 },
      },
    },
  });
  assert.equal(actResp.result.isError, false);
  assert.equal(actResp.result.structuredContent.status, 'submitted');
  assert.equal(actResp.result.content[1].type, 'image');
  const lastActionCmd = receivedCommands.filter((c) => c.method === 'action').at(-1);
  assert.equal(lastActionCmd.params.plan.absX, 960);
  assert.equal(lastActionCmd.params.plan.absY, 540);
  const obs2 = actResp.result.structuredContent.observation.observation_id;
  assert.notEqual(obs2, obs1);

  // Replaying same operation_id + same args returns cached result without re-dispatching to browser.
  const actionCountBeforeReplay = receivedCommands.filter((c) => c.method === 'action').length;
  const replayResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'uu_action',
      arguments: {
        session_id: 'uu:dev42',
        operation_id: 'op_click_1',
        observation_id: obs1,
        action: { type: 'click', x: 480, y: 270 },
      },
    },
  });
  assert.equal(replayResp.result.isError, false);
  assert.equal(receivedCommands.filter((c) => c.method === 'action').length, actionCountBeforeReplay);

  // Reusing operation_id with different arguments fails with OPERATION_CONFLICT.
  const conflictResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'uu_action',
      arguments: {
        session_id: 'uu:dev42',
        operation_id: 'op_click_1',
        observation_id: obs1,
        action: { type: 'click', x: 100, y: 100 },
      },
    },
  });
  assert.equal(conflictResp.result.isError, true);
  assert.equal(conflictResp.result.structuredContent.error.code, 'OPERATION_CONFLICT');

  // Human pause overrides Agent control and prevents uu_set_control(true).
  await fetch(`${origin}/__uubridge/agent/viewer-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'uu:dev42', operation: 'pause' }),
  });
  const pausedAct = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'uu_action',
      arguments: {
        session_id: 'uu:dev42',
        operation_id: 'op_while_paused',
        observation_id: obs2,
        action: { type: 'key_press', key: 'ENTER' },
      },
    },
  });
  assert.equal(pausedAct.result.isError, true);
  assert.equal(pausedAct.result.structuredContent.error.code, 'HUMAN_PAUSED');

  const overridePause = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'uu_set_control', arguments: { session_id: 'uu:dev42', enabled: true } },
  });
  assert.equal(overridePause.result.isError, true);
  assert.equal(overridePause.result.structuredContent.error.code, 'HUMAN_PAUSED');

  // Human resumes; clipboard set/get works.
  await fetch(`${origin}/__uubridge/agent/viewer-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'uu:dev42', operation: 'resume' }),
  });
  const clipSet = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'uu_clipboard_set', arguments: { session_id: 'uu:dev42', operation_id: 'clip_1', text: 'hello UU' } },
  });
  assert.equal(clipSet.result.isError, false);
  const clipGet = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'uu_clipboard_get', arguments: { session_id: 'uu:dev42' } },
  });
  assert.equal(clipGet.result.structuredContent.text, 'hello UU');

  // Switching display invalidates prior observations (obs2 must be rejected as stale/missing).
  const dispResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'uu_select_display', arguments: { session_id: 'uu:dev42', display_index: 1 } },
  });
  assert.equal(dispResp.result.isError, false);
  assert.equal(dispResp.result.structuredContent.active_display_index, 1);

  const staleAct = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: {
      name: 'uu_action',
      arguments: {
        session_id: 'uu:dev42',
        operation_id: 'op_after_display',
        observation_id: obs2,
        action: { type: 'key_press', key: 'ENTER' },
      },
    },
  });
  assert.equal(staleAct.result.isError, true);
  assert.equal(staleAct.result.structuredContent.error.code, 'OBSERVATION_NOT_FOUND');

  // Disconnect cleans up session.
  const discResp = await mcp.handleRpcMessage({
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: { name: 'uu_disconnect', arguments: { session_id: 'uu:dev42' } },
  });
  assert.equal(discResp.result.isError, false);
  assert.equal(discResp.result.structuredContent.disconnected, true);
});

test('held inputs block type_text and auto-release when the lease expires', async (t) => {
  let origin = '';
  const broker = createAgentBroker({ getOrigin: () => origin, heldInputLeaseMs: 120 });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/__uubridge/mcp/')) {
      void broker.handleAgentRequest(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/__uubridge/agent/')) {
      void broker.handleBrowserRequest(req, res, url);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const releases = [];
  const mockTab = await connectMockBrowserTab(origin, 'tab_lease', (cmd) => {
    if (cmd.method === 'screenshot') {
      return {
        display_index: 0,
        source_size: { width: 1280, height: 720 },
        image_size: { width: 1280, height: 720 },
        region: { x: 0, y: 0, width: 1280, height: 720 },
        frame_id: 1,
        snapshot_id: 'snap_lease_1',
        png_base64: TINY_PNG_BASE64,
      };
    }
    if (cmd.method === 'action') {
      return { status: 'submitted', has_held_inputs: true, after_frame_id: 2 };
    }
    if (cmd.method === 'release_inputs') {
      releases.push(cmd.params);
      return { released: true, has_held_inputs: false };
    }
    throw new Error(`unexpected ${cmd.method}`);
  });

  t.after(async () => {
    mockTab.close();
    broker.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });

  await fetch(`${origin}/__uubridge/agent/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tab_id: 'tab_lease',
      sessions: [
        {
          device_id: 'dev_lease',
          device_name: 'Lease-Box',
          stage: 'connected',
          source_size: { width: 1280, height: 720 },
          video_ready: true,
          control_channel_open: true,
        },
      ],
    }),
  });
  await fetch(`${origin}/__uubridge/agent/viewer-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'uu:dev_lease', operation: 'authorize' }),
  });

  const authHeaders = {
    Authorization: `Bearer ${broker.agentToken}`,
    'Content-Type': 'application/json',
  };
  const shot = await fetch(`${origin}/__uubridge/mcp/screenshot`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ session_id: 'uu:dev_lease' }),
  }).then((r) => r.json());

  const downRes = await fetch(`${origin}/__uubridge/mcp/action`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      session_id: 'uu:dev_lease',
      operation_id: 'op_hold_shift',
      observation_id: shot.observation_id,
      action: { type: 'key_down', key: 'SHIFT' },
      observe_after: false,
    }),
  });
  assert.equal(downRes.status, 200);

  // While SHIFT is held, type_text must be rejected with HELD_INPUT_ACTIVE.
  const blockedText = await fetch(`${origin}/__uubridge/mcp/action`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      session_id: 'uu:dev_lease',
      operation_id: 'op_type_blocked',
      observation_id: shot.observation_id,
      action: { type: 'type_text', text: 'abc' },
      observe_after: false,
    }),
  });
  assert.equal(blockedText.status, 409);
  assert.equal((await blockedText.json()).error.code, 'HELD_INPUT_ACTIVE');

  // Wait past the 120ms lease and confirm release_inputs was automatically sent.
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.ok(releases.some((r) => r.reason === 'held_lease_expired'));
});

test('local-run.mjs isolates Cookie vs Bearer auth and works over real stdio MCP subprocess', async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'uubridge-e2e-'));
  const accessPath = path.join(tempDir, 'access.json');
  const { server, accessInfo } = await startLocalUuWebServer({
    host: '127.0.0.1',
    port: 0,
    accessPath,
    enableTee: false,
  });

  let child;
  let sseReq;
  t.after(async () => {
    sseReq?.destroy();
    if (child && !child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  // 1) Unauthenticated browser agent endpoint rejected with 403.
  assert.equal((await fetch(`${accessInfo.origin}/__uubridge/agent/capabilities`)).status, 403);

  // 2) Authenticate browser session via loginUrl -> receive HttpOnly cookie.
  const loginRes = await fetch(accessInfo.loginUrl, { redirect: 'manual' });
  assert.equal(loginRes.status, 303);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  // 3) Cookie can access /__uubridge/agent/capabilities, but CANNOT access /__uubridge/mcp/sessions.
  const capRes = await fetch(`${accessInfo.origin}/__uubridge/agent/capabilities`, {
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(capRes.status, 200);
  assert.equal((await capRes.json()).agent_bridge, true);

  const cookieToMcp = await fetch(`${accessInfo.origin}/__uubridge/mcp/sessions`, {
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(cookieToMcp.status, 401);

  // 4) Agent Bearer token CANNOT call browser-only viewer-control (human authority boundary).
  const agentToViewer = await fetch(`${accessInfo.origin}/__uubridge/agent/viewer-control`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessInfo.agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session_id: 'uu:dev9', operation: 'authorize' }),
  });
  assert.equal(agentToViewer.status, 403);

  // 5) Connect authenticated browser SSE tab and verify real stdio MCP subprocess.
  await new Promise((resolve, reject) => {
    sseReq = http.get(
      `${accessInfo.origin}/__uubridge/agent/events?tabId=tab_stdio_1`,
      { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } },
      (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes('event: hello')) resolve();
        });
      },
    );
    sseReq.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });

  child = spawn(process.execPath, [path.join(ROOT, 'agent', 'mcp-server.mjs')], {
    env: { ...process.env, UUBRIDGE_ACCESS_FILE: accessPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');

  let stdoutBuf = '';
  const pendingRpc = new Map();
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = pendingRpc.get(msg.id);
      if (waiter) {
        pendingRpc.delete(msg.id);
        waiter(msg);
      }
    }
  });

  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC ${method} timeout`)), 5000);
      pendingRpc.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const init = await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  assert.equal(init.result.serverInfo.name, 'uubridge-mcp');
  const sessions = await rpc(2, 'tools/call', { name: 'uu_list_sessions', arguments: {} });
  assert.equal(sessions.result.isError, false);
  assert.equal(sessions.result.structuredContent.browser_tabs_connected, 1);
  assert.deepEqual(sessions.result.structuredContent.sessions, []);
});
