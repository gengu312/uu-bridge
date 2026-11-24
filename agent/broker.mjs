import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AgentFailure,
  HELD_INPUT_LEASE_MS,
  MAX_CLIPBOARD_READ_BYTES,
  MAX_OBSERVATION_ENTRIES,
  MAX_OPERATION_CACHE_ENTRIES,
  MAX_WAIT_MS,
  OBSERVATION_TTL_MS,
  OPERATION_CACHE_TTL_MS,
  PROTOCOL_VERSION,
  canonicalStringify,
  formatFailure,
  randomId,
  resolveActionPlan,
  summarizeAction,
  validateActionRequest,
  validateClipboardSetArgs,
  validateControlArgs,
  validateDisplayArgs,
  validateId,
  validateScreenshotArgs,
  validateWaitArgs,
} from './protocol.mjs';

function matchesSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  const type = req.headers['content-type']?.split(';')[0]?.trim();
  if (type !== 'application/json') {
    throw new AgentFailure('INVALID_ARGUMENT', '需要 application/json 请求体。', { status: 415 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new AgentFailure('INVALID_ARGUMENT', '请求体超过大小限制。', { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch {
    throw new AgentFailure('INVALID_ARGUMENT', '无效的 JSON 请求体。');
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(payload));
}

function platformName(platform) {
  if (platform === 1) return 'windows';
  if (platform === 2) return 'android';
  if (platform === 3) return 'ios';
  if (platform === 4) return 'macos';
  return 'unknown';
}

export function createAgentBroker({
  agentToken = randomBytes(32).toString('base64url'),
  origin = 'http://127.0.0.1:18789',
  getOrigin = null,
  heldInputLeaseMs = HELD_INPUT_LEASE_MS,
  now = () => Date.now(),
} = {}) {
  const resolveOrigin = () => (typeof getOrigin === 'function' ? getOrigin() : origin);
  const tabs = new Map();
  const sessions = new Map();
  const observations = new Map();
  const operations = new Map();
  const pendingCommands = new Map();
  const sessionWaiters = new Set();

  let commandSeq = 0;

  function notifyWaiters() {
    for (const notify of sessionWaiters) notify();
  }

  function pruneObservations() {
    const cutoff = now() - OBSERVATION_TTL_MS;
    for (const [id, entry] of observations) {
      if (entry.captured_at < cutoff) observations.delete(id);
    }
    while (observations.size > MAX_OBSERVATION_ENTRIES) {
      const oldestKey = observations.keys().next().value;
      observations.delete(oldestKey);
    }
  }

  function pruneOperations() {
    const cutoff = now() - OPERATION_CACHE_TTL_MS;
    for (const [key, entry] of operations) {
      if (entry.status !== 'in_progress' && entry.updated_at < cutoff) {
        operations.delete(key);
      }
    }
    while (operations.size > MAX_OPERATION_CACHE_ENTRIES) {
      const oldestKey = operations.keys().next().value;
      const entry = operations.get(oldestKey);
      if (entry?.status === 'in_progress') break;
      operations.delete(oldestKey);
    }
  }

  function invalidateSessionObservations(sessionId) {
    for (const [id, entry] of observations) {
      if (entry.session_id === sessionId) observations.delete(id);
    }
  }

  function recordObservation(session, payload) {
    pruneObservations();
    const observation_id = randomId('obs');
    const captured_at = now();
    const entry = {
      observation_id,
      session_id: session.session_id,
      generation: session.generation,
      geometry_epoch: session.geometry_epoch,
      display_index: payload.display_index ?? session.active_display_index,
      source_size: payload.source_size ?? session.source_size,
      image_size: payload.image_size,
      region: payload.region ?? {
        x: 0,
        y: 0,
        width: (payload.source_size ?? session.source_size).width,
        height: (payload.source_size ?? session.source_size).height,
      },
      frame_id: payload.frame_id ?? session.frame_id,
      snapshot_id: typeof payload.snapshot_id === 'string' ? payload.snapshot_id : null,
      captured_at,
      coordinate_space: 'observation_image_pixels',
    };
    observations.set(observation_id, entry);
    return entry;
  }

  function publicObservation(entry) {
    const { snapshot_id: _ignored, ...rest } = entry;
    return rest;
  }

  function buildSessionPublicView(session) {
    const controlAllowed = Boolean(
      session.stage === 'connected' &&
      session.control_channel_open &&
      session.authorized &&
      !session.human_paused &&
      session.agent_control_enabled,
    );
    const frameAgeMs = session.last_frame_at > 0 ? Math.max(0, now() - session.last_frame_at) : null;
    return {
      session_id: session.session_id,
      device_id: session.device_id,
      device_name: session.device_name,
      stage: session.stage,
      ready: Boolean(
        session.stage === 'connected' &&
        session.video_ready &&
        session.source_size.width > 0 &&
        session.source_size.height > 0,
      ),
      target_platform: platformName(session.target_platform),
      generation: session.generation,
      geometry_epoch: session.geometry_epoch,
      source_size: session.source_size,
      displays: session.displays,
      active_display_index: session.active_display_index,
      frame_id: session.frame_id,
      frame_age_ms: frameAgeMs,
      video_ready: session.video_ready,
      video_stalled: session.video_stalled,
      data_channels: {
        control: session.control_channel_open ? 'open' : 'closed',
        text: session.text_channel_open ? 'open' : 'closed',
        file: session.file_channel_open ? 'open' : 'closed',
      },
      authorized: session.authorized,
      human_paused: session.human_paused,
      auto_pause_on_human_input: session.auto_pause_on_human_input,
      agent_control_enabled: session.agent_control_enabled,
      control_allowed: controlAllowed,
      has_held_inputs: session.has_held_inputs,
      busy: Boolean(session.in_flight_action),
      last_action: session.last_action ?? null,
    };
  }

  function pushPolicyToTab(session) {
    const tab = tabs.get(session.tab_id);
    if (!tab || tab.res.writableEnded) return;
    writeSse(tab.res, 'policy', {
      session_id: session.session_id,
      device_id: session.device_id,
      authorized: session.authorized,
      human_paused: session.human_paused,
      auto_pause_on_human_input: session.auto_pause_on_human_input,
      agent_control_enabled: session.agent_control_enabled,
      control_allowed: buildSessionPublicView(session).control_allowed,
      busy: Boolean(session.in_flight_action),
      has_held_inputs: session.has_held_inputs,
      last_action: session.last_action ?? null,
    });
  }

  function clearHeldLease(session) {
    if (session.held_lease_timer) {
      clearTimeout(session.held_lease_timer);
      session.held_lease_timer = null;
    }
    session.has_held_inputs = false;
  }

  function renewHeldLease(session) {
    if (session.held_lease_timer) clearTimeout(session.held_lease_timer);
    session.has_held_inputs = true;
    session.held_lease_timer = setTimeout(() => {
      session.held_lease_timer = null;
      session.has_held_inputs = false;
      void sendTabCommandBestEffort(session.tab_id, 'release_inputs', {
        device_id: session.device_id,
        reason: 'held_lease_expired',
      });
      pushPolicyToTab(session);
    }, heldInputLeaseMs);
    session.held_lease_timer.unref?.();
  }

  function writeSse(res, event, data) {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  function sendTabCommand(tabId, method, params, timeoutMs = 15_000) {
    const tab = tabs.get(tabId);
    if (!tab || tab.res.writableEnded || tab.res.destroyed) {
      return Promise.reject(
        new AgentFailure('BROWSER_OFFLINE', '本地 UU 网页主控标签页未连接，请保持网页主控处于打开状态。', {
          retryable: true,
        }),
      );
    }
    const request_id = `cmd_${++commandSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(request_id);
        reject(new AgentFailure('TIMEOUT', `浏览器执行 ${method} 超时。`, {
          retryable: true,
          sideEffectPossible: method === 'action' || method === 'clipboard_set',
        }));
      }, timeoutMs);
      timer.unref?.();
      pendingCommands.set(request_id, {
        tabId,
        method,
        resolve,
        reject,
        timer,
      });
      const written = writeSse(tab.res, 'command', { request_id, method, params });
      if (!written) {
        clearTimeout(timer);
        pendingCommands.delete(request_id);
        reject(new AgentFailure('BROWSER_OFFLINE', '无法向浏览器网页主控发送命令。', { retryable: true }));
      }
    });
  }

  function sendTabCommandBestEffort(tabId, method, params) {
    return sendTabCommand(tabId, method, params, 3_000).catch(() => undefined);
  }

  function removeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    clearInterval(tab.heartbeat);
    tabs.delete(tabId);
    for (const [reqId, pending] of pendingCommands) {
      if (pending.tabId === tabId) {
        clearTimeout(pending.timer);
        pendingCommands.delete(reqId);
        pending.reject(
          new AgentFailure('BROWSER_OFFLINE', '网页主控标签页已关闭或断开。', {
            retryable: true,
            sideEffectPossible: pending.method === 'action' || pending.method === 'clipboard_set',
          }),
        );
      }
    }
    for (const [sessionId, session] of sessions) {
      if (session.tab_id === tabId) {
        clearHeldLease(session);
        invalidateSessionObservations(sessionId);
        sessions.delete(sessionId);
      }
    }
    notifyWaiters();
  }

  function syncTabSessions(tabId, reportedSessions = []) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.lastSeenAt = now();
    const seenIds = new Set();

    for (const item of reportedSessions) {
      if (!item || typeof item.device_id !== 'string' || !item.device_id) continue;
      const session_id = `uu:${item.device_id}`;
      seenIds.add(session_id);
      const existing = sessions.get(session_id);
      const width = Number.isInteger(item.source_size?.width) && item.source_size.width > 0 ? item.source_size.width : 0;
      const height = Number.isInteger(item.source_size?.height) && item.source_size.height > 0 ? item.source_size.height : 0;
      const displays = Array.isArray(item.displays) ? item.displays : [];
      const activeDisplay = Number.isInteger(item.active_display_index) ? item.active_display_index : 0;
      const frameId = Number.isInteger(item.frame_id) && item.frame_id >= 0 ? item.frame_id : 0;
      const stage = typeof item.stage === 'string' ? item.stage : 'idle';

      if (!existing) {
        const created = {
          session_id,
          device_id: item.device_id,
          device_name: typeof item.device_name === 'string' && item.device_name ? item.device_name : item.device_id,
          tab_id: tabId,
          stage,
          target_platform: item.target_platform,
          generation: 1,
          geometry_epoch: 1,
          source_size: { width, height },
          displays,
          active_display_index: activeDisplay,
          frame_id: frameId,
          last_frame_at: item.video_ready ? now() : 0,
          video_ready: Boolean(item.video_ready),
          video_stalled: Boolean(item.video_stalled),
          control_channel_open: Boolean(item.control_channel_open),
          text_channel_open: Boolean(item.text_channel_open),
          file_channel_open: Boolean(item.file_channel_open),
          // Default to observe-only until human explicitly authorizes Agent control in the browser bar.
          authorized: false,
          human_paused: false,
          auto_pause_on_human_input: true,
          agent_control_enabled: true,
          has_held_inputs: false,
          held_lease_timer: null,
          in_flight_action: null,
          last_action: null,
          session_instance_id: item.session_instance_id ?? '',
        };
        sessions.set(session_id, created);
        pushPolicyToTab(created);
      } else {
        const reconnected =
          existing.tab_id !== tabId ||
          (existing.stage !== 'connected' && stage === 'connected') ||
          (item.session_instance_id && existing.session_instance_id && item.session_instance_id !== existing.session_instance_id);
        const displayChanged = existing.active_display_index !== activeDisplay;
        const geometryChanged =
          (width > 0 && height > 0) &&
          (existing.source_size.width !== width || existing.source_size.height !== height);

        existing.tab_id = tabId;
        existing.device_name = typeof item.device_name === 'string' && item.device_name ? item.device_name : existing.device_name;
        existing.stage = stage;
        existing.target_platform = item.target_platform ?? existing.target_platform;
        existing.displays = displays;
        existing.active_display_index = activeDisplay;
        existing.video_ready = Boolean(item.video_ready);
        existing.video_stalled = Boolean(item.video_stalled);
        existing.control_channel_open = Boolean(item.control_channel_open);
        existing.text_channel_open = Boolean(item.text_channel_open);
        existing.file_channel_open = Boolean(item.file_channel_open);
        if (item.session_instance_id) existing.session_instance_id = item.session_instance_id;

        if (frameId !== existing.frame_id || (existing.video_ready && !existing.video_stalled && existing.last_frame_at === 0)) {
          existing.frame_id = frameId;
          existing.last_frame_at = now();
        }
        if (width > 0 && height > 0) {
          existing.source_size = { width, height };
        }
        if (reconnected || displayChanged) {
          existing.generation += 1;
          clearHeldLease(existing);
          invalidateSessionObservations(session_id);
        }
        if (geometryChanged) {
          existing.geometry_epoch += 1;
          invalidateSessionObservations(session_id);
        }
        if (stage !== 'connected' || !existing.control_channel_open) {
          clearHeldLease(existing);
        }
      }
    }

    for (const [sessionId, session] of sessions) {
      if (session.tab_id === tabId && !seenIds.has(sessionId)) {
        clearHeldLease(session);
        invalidateSessionObservations(sessionId);
        sessions.delete(sessionId);
      }
    }
    notifyWaiters();
  }

  function requireSession(sessionId) {
    validateId(sessionId, 'session_id');
    const session = sessions.get(sessionId);
    if (!session) {
      throw new AgentFailure(
        'SESSION_NOT_FOUND',
        `未找到会话 ${sessionId}。请先在本地 UU 网页主控中连接远端设备，再调用 uu_list_sessions。`,
      );
    }
    return session;
  }

  function assertControlAllowed(session) {
    if (session.stage !== 'connected' || !session.control_channel_open) {
      throw new AgentFailure('SESSION_NOT_READY', '远端控制通道尚未就绪，请等待设备连接完成。', { retryable: true });
    }
    if (!session.authorized) {
      throw new AgentFailure(
        'CONTROL_DENIED',
        '当前会话处于仅观察模式。请用户在本地 UU 网页主控右下角控制条中开启「允许 Agent 控制」。',
      );
    }
    if (session.human_paused) {
      throw new AgentFailure(
        'HUMAN_PAUSED',
        '用户已在本地网页主控暂停了 Agent 控制（人工接管中）。等待用户在控制条点击「恢复 Agent」后再继续。',
      );
    }
    if (!session.agent_control_enabled) {
      throw new AgentFailure('CONTROL_DENIED', 'Agent 控制当前已关闭，可调用 uu_set_control(enabled: true) 恢复。');
    }
  }

  function requireValidObservation(session, observationId) {
    const obs = observations.get(observationId);
    if (!obs || obs.session_id !== session.session_id) {
      throw new AgentFailure('OBSERVATION_NOT_FOUND', 'observation_id 不存在或已过期，请先重新调用 uu_screenshot。');
    }
    if (now() - obs.captured_at > OBSERVATION_TTL_MS) {
      observations.delete(observationId);
      throw new AgentFailure('OBSERVATION_STALE', '观测已过期，请重新调用 uu_screenshot。');
    }
    if (obs.generation !== session.generation || obs.geometry_epoch !== session.geometry_epoch) {
      throw new AgentFailure(
        'OBSERVATION_STALE',
        '远端连接、显示器或分辨率已发生变化，旧截图坐标已失效，请重新调用 uu_screenshot。',
      );
    }
    if (!session.video_ready || session.video_stalled) {
      throw new AgentFailure('VIDEO_STALLED', '远端视频画面尚未就绪或已停滞，暂不发送输入。', { retryable: true });
    }
    return obs;
  }

  function applyViewerControl(body) {
    const session = requireSession(body.session_id);
    const op = body.operation;
    switch (op) {
      case 'authorize':
        session.authorized = true;
        session.human_paused = false;
        break;
      case 'revoke':
        session.authorized = false;
        session.human_paused = false;
        abortInFlightAndRelease(session, 'human_revoked');
        break;
      case 'pause':
        session.human_paused = true;
        abortInFlightAndRelease(session, body.reason || 'human_paused');
        break;
      case 'resume':
        if (session.authorized) session.human_paused = false;
        break;
      case 'release_inputs':
        abortInFlightAndRelease(session, 'human_release');
        break;
      case 'set_auto_pause':
        session.auto_pause_on_human_input = Boolean(body.enabled);
        break;
      default:
        throw new AgentFailure('INVALID_ARGUMENT', `未知的 viewer_control 操作：${op}`);
    }
    pushPolicyToTab(session);
    notifyWaiters();
    return buildSessionPublicView(session);
  }

  function abortInFlightAndRelease(session, reason) {
    clearHeldLease(session);
    if (session.in_flight_action) {
      session.in_flight_action.aborted = true;
      session.in_flight_action.reason = reason;
    }
    void sendTabCommandBestEffort(session.tab_id, 'cancel_and_release', {
      device_id: session.device_id,
      reason,
    });
  }

  async function handleGetSession(url) {
    const sessionId = url.searchParams.get('session_id');
    const waitMsRaw = url.searchParams.get('wait_ms');
    const waitMs = waitMsRaw !== null ? Number(waitMsRaw) : 0;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      throw new AgentFailure('INVALID_ARGUMENT', `wait_ms 必须是 0–${MAX_WAIT_MS} 的整数。`);
    }

    const check = () => {
      if (sessionId) {
        const s = sessions.get(sessionId);
        if (!s) return null;
        const view = buildSessionPublicView(s);
        return view.ready ? view : null;
      }
      const list = [...sessions.values()].map(buildSessionPublicView);
      const ready = list.find((item) => item.ready);
      return ready ?? null;
    };

    if (waitMs === 0) {
      if (sessionId) return buildSessionPublicView(requireSession(sessionId));
      return {
        browser_tabs_connected: tabs.size,
        sessions: [...sessions.values()].map(buildSessionPublicView),
      };
    }

    const immediate = check();
    if (immediate) return { ...immediate, wait_timed_out: false };

    const deadline = now() + waitMs;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sessionWaiters.delete(onUpdate);
        resolve();
      };
      const onUpdate = () => {
        if (check()) finish();
      };
      const timer = setTimeout(finish, Math.max(0, deadline - now()));
      timer.unref?.();
      sessionWaiters.add(onUpdate);
    });

    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) {
        return {
          session_id: sessionId,
          ready: false,
          browser_tabs_connected: tabs.size,
          wait_timed_out: true,
        };
      }
      const view = buildSessionPublicView(s);
      return { ...view, wait_timed_out: !view.ready };
    }
    const list = [...sessions.values()].map(buildSessionPublicView);
    const ready = list.find((item) => item.ready);
    if (ready) return { ...ready, wait_timed_out: false };
    return {
      ready: false,
      browser_tabs_connected: tabs.size,
      sessions: list,
      wait_timed_out: true,
    };
  }

  async function handleScreenshot(rawBody) {
    const args = validateScreenshotArgs(rawBody);
    const session = requireSession(args.session_id);
    if (session.stage !== 'connected') {
      throw new AgentFailure('SESSION_NOT_READY', '远端设备尚未连接。', { retryable: true });
    }
    if (args.generation !== undefined && args.generation !== session.generation) {
      throw new AgentFailure('OBSERVATION_STALE', '请求的 generation 与当前会话不一致。');
    }
    const reply = await sendTabCommand(
      session.tab_id,
      'screenshot',
      {
        device_id: session.device_id,
        region: args.region,
        max_edge: args.max_edge,
        after_frame_id: args.after_frame_id,
        timeout_ms: args.timeout_ms,
      },
      args.timeout_ms + 8_000,
    );
    if (reply.source_size?.width > 0 && reply.source_size?.height > 0) {
      if (
        session.source_size.width > 0 &&
        (session.source_size.width !== reply.source_size.width || session.source_size.height !== reply.source_size.height)
      ) {
        session.geometry_epoch += 1;
        invalidateSessionObservations(session.session_id);
      }
      session.source_size = reply.source_size;
      session.video_ready = true;
      session.video_stalled = false;
      session.last_frame_at = now();
      if (Number.isInteger(reply.frame_id)) session.frame_id = reply.frame_id;
    }
    const obs = recordObservation(session, reply);
    return {
      ...publicObservation(obs),
      mime_type: 'image/png',
      data: reply.png_base64,
    };
  }

  async function handleAction(rawBody) {
    const req = validateActionRequest(rawBody);
    const session = requireSession(req.session_id);
    pruneOperations();

    const opKey = `${req.session_id}::${req.operation_id}`;
    const argsHash = canonicalStringify({
      session_id: req.session_id,
      observation_id: req.observation_id,
      action: req.action,
      observe_after: req.observe_after,
      wait: req.wait,
    });

    const cached = operations.get(opKey);
    if (cached) {
      if (cached.args_hash !== argsHash) {
        throw new AgentFailure(
          'OPERATION_CONFLICT',
          `operation_id ${req.operation_id} 已被用于不同的参数，请使用新的 operation_id 或以原参数查询。`,
        );
      }
      if (cached.status === 'in_progress') {
        return {
          status: 'in_progress',
          operation_id: req.operation_id,
          retryable: true,
          side_effect_possible: true,
        };
      }
      return cached.result;
    }

    assertControlAllowed(session);
    const observation = requireValidObservation(session, req.observation_id);

    let waitRegion = observation.region;
    let waitBaselineObservationId = req.observation_id;
    let waitBaselineSnapshotId = observation.snapshot_id;
    if (req.wait?.observation_id) {
      const waitObs = requireValidObservation(session, req.wait.observation_id);
      waitRegion = waitObs.region;
      waitBaselineObservationId = waitObs.observation_id;
      waitBaselineSnapshotId = waitObs.snapshot_id;
    }

    if (req.action.type === 'type_text' && session.has_held_inputs) {
      throw new AgentFailure('HELD_INPUT_ACTIVE', '当前有长按中的键鼠，执行 type_text 前请先调用 uu_release_inputs。');
    }
    if (req.action.type === 'sequence' && session.has_held_inputs) {
      throw new AgentFailure('HELD_INPUT_ACTIVE', '当前有长按中的键鼠，执行 sequence 前请先调用 uu_release_inputs。');
    }
    if (session.in_flight_action) {
      throw new AgentFailure('SESSION_BUSY', '同一会话正在执行另一条输入动作，请等待完成后再提交。', { retryable: true });
    }

    const plan = resolveActionPlan(req.action, observation);
    const summary = summarizeAction(req.action);
    const generationAtStart = session.generation;
    const geometryAtStart = session.geometry_epoch;

    const opRecord = {
      args_hash: argsHash,
      status: 'in_progress',
      result: null,
      created_at: now(),
      updated_at: now(),
    };
    operations.set(opKey, opRecord);

    const flight = {
      operation_id: req.operation_id,
      aborted: false,
      reason: null,
    };
    session.in_flight_action = flight;
    session.last_action = { at: now(), type: req.action.type, summary, status: 'in_progress' };
    pushPolicyToTab(session);

    const isHeldOnly = ['move', 'mouse_down', 'mouse_up', 'key_down', 'key_up'].includes(req.action.type);
    const effectiveWait = req.observe_after
      ? (req.wait ?? (isHeldOnly ? { condition: 'frame', timeout_ms: 400 } : { condition: 'changed', stable_ms: 200, timeout_ms: 1000 }))
      : null;

    const timeoutMs =
      (req.action.type === 'sequence' ? 25_000 : (req.action.duration_ms ?? 500) + 8_000) +
      (effectiveWait ? (effectiveWait.timeout_ms ?? 1_000) + 2_000 : 0);

    try {
      const reply = await sendTabCommand(
        session.tab_id,
        'action',
        {
          device_id: session.device_id,
          operation_id: req.operation_id,
          plan,
          observe_after: req.observe_after,
          wait: effectiveWait
            ? {
                ...effectiveWait,
                baseline_observation_id: waitBaselineObservationId,
                baseline_snapshot_id: waitBaselineSnapshotId,
                region: waitRegion,
                max_edge: observation.image_size?.width
                  ? Math.max(observation.image_size.width, observation.image_size.height)
                  : 1280,
              }
            : null,
        },
        timeoutMs,
      );

      if (reply.has_held_inputs) renewHeldLease(session);
      else clearHeldLease(session);

      let postObservation = null;
      if (reply.screenshot?.png_base64) {
        if (reply.screenshot.source_size?.width > 0 && reply.screenshot.source_size?.height > 0) {
          if (
            session.source_size.width > 0 &&
            (session.source_size.width !== reply.screenshot.source_size.width ||
              session.source_size.height !== reply.screenshot.source_size.height)
          ) {
            session.geometry_epoch += 1;
            invalidateSessionObservations(session.session_id);
          }
          session.source_size = reply.screenshot.source_size;
          session.last_frame_at = now();
          if (Number.isInteger(reply.screenshot.frame_id)) session.frame_id = reply.screenshot.frame_id;
        }
        const obs = recordObservation(session, reply.screenshot);
        postObservation = {
          ...publicObservation(obs),
          mime_type: 'image/png',
          data: reply.screenshot.png_base64,
        };
      }

      const result = {
        status: reply.status ?? 'submitted',
        operation_id: req.operation_id,
        session_id: session.session_id,
        generation: session.generation,
        geometry_epoch: session.geometry_epoch,
        generation_changed: session.generation !== generationAtStart || session.geometry_epoch !== geometryAtStart,
        after_frame_id: reply.after_frame_id ?? session.frame_id,
        remote_execution: 'submitted_via_uu_datachannel',
        retryable: false,
        side_effect_possible: reply.status !== 'failed_before_submit',
        ...(reply.sequence ? { sequence: reply.sequence } : {}),
        ...(reply.wait_result ? { wait: reply.wait_result } : {}),
        ...(reply.timing_ms ? { timing_ms: reply.timing_ms } : {}),
        ...(postObservation ? { observation: postObservation } : {}),
      };

      opRecord.status = result.status;
      opRecord.result = result;
      opRecord.updated_at = now();
      session.last_action = { at: now(), type: req.action.type, summary, status: result.status };
      return result;
    } catch (error) {
      const fail = formatFailure(error);
      const status = fail.side_effect_possible ? 'outcome_unknown' : 'failed_before_submit';
      const result = {
        status,
        operation_id: req.operation_id,
        session_id: session.session_id,
        retryable: fail.retryable,
        side_effect_possible: fail.side_effect_possible,
        error: fail,
      };
      opRecord.status = status;
      opRecord.result = result;
      opRecord.updated_at = now();
      session.last_action = { at: now(), type: req.action.type, summary, status };
      clearHeldLease(session);
      throw error;
    } finally {
      if (session.in_flight_action === flight) session.in_flight_action = null;
      pushPolicyToTab(session);
    }
  }

  async function handleWait(rawBody) {
    const args = validateWaitArgs(rawBody);
    const session = requireSession(args.session_id);
    const obs = requireValidObservation(session, args.observation_id);
    const reply = await sendTabCommand(
      session.tab_id,
      'wait',
      {
        device_id: session.device_id,
        observation_id: args.observation_id,
        baseline_snapshot_id: obs.snapshot_id,
        condition: args.condition,
        region: obs.region,
        max_edge: Math.max(obs.image_size.width, obs.image_size.height),
        stable_ms: args.stable_ms,
        timeout_ms: args.timeout_ms,
      },
      args.timeout_ms + 8_000,
    );
    let fresh = null;
    if (reply.screenshot?.png_base64) {
      if (Number.isInteger(reply.screenshot.frame_id)) session.frame_id = reply.screenshot.frame_id;
      session.last_frame_at = now();
      const recorded = recordObservation(session, reply.screenshot);
      fresh = {
        ...publicObservation(recorded),
        mime_type: 'image/png',
        data: reply.screenshot.png_base64,
      };
    }
    return {
      session_id: session.session_id,
      condition: args.condition,
      matched: Boolean(reply.matched),
      wait_timed_out: !reply.matched,
      elapsed_ms: reply.elapsed_ms ?? 0,
      ...(fresh ? { observation: fresh } : {}),
    };
  }

  async function handleReleaseInputs(rawBody) {
    const session = requireSession(rawBody?.session_id);
    abortInFlightAndRelease(session, 'agent_release');
    await sendTabCommand(session.tab_id, 'release_inputs', {
      device_id: session.device_id,
      reason: 'agent_release',
    }, 5_000);
    pushPolicyToTab(session);
    return {
      ok: true,
      session_id: session.session_id,
      has_held_inputs: false,
    };
  }

  async function handleSetControl(rawBody) {
    const args = validateControlArgs(rawBody);
    const session = requireSession(args.session_id);
    if (args.enabled) {
      if (!session.authorized) {
        throw new AgentFailure(
          'CONTROL_DENIED',
          '无法在未经用户授权的情况下启用控制。请用户在本地 UU 网页主控开启「允许 Agent 控制」。',
        );
      }
      if (session.human_paused) {
        throw new AgentFailure(
          'HUMAN_PAUSED',
          '用户已手动暂停 Agent 控制，Agent 不可自行恢复；请等待用户在网页控制条点击「恢复 Agent」。',
        );
      }
    } else {
      abortInFlightAndRelease(session, 'agent_disabled_control');
    }
    session.agent_control_enabled = args.enabled;
    pushPolicyToTab(session);
    notifyWaiters();
    return buildSessionPublicView(session);
  }

  async function handleClipboard(rawBody) {
    const operation = rawBody?.operation;
    if (operation === 'get') {
      const session = requireSession(rawBody?.session_id);
      assertControlAllowed(session);
      const reply = await sendTabCommand(
        session.tab_id,
        'clipboard_get',
        { device_id: session.device_id, timeout_ms: 4_000 },
        6_000,
      );
      const text = typeof reply.text === 'string' ? reply.text : '';
      if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_READ_BYTES) {
        throw new AgentFailure('INVALID_ARGUMENT', '远端剪贴板内容超过 128 KiB 上限。');
      }
      return {
        session_id: session.session_id,
        text,
        source: reply.source ?? 'remote',
      };
    }
    if (operation === 'set') {
      const args = validateClipboardSetArgs(rawBody);
      const session = requireSession(args.session_id);
      pruneOperations();
      const opKey = `${args.session_id}::clipboard::${args.operation_id}`;
      const argsHash = canonicalStringify({ text: args.text });
      const cached = operations.get(opKey);
      if (cached) {
        if (cached.args_hash !== argsHash) {
          throw new AgentFailure('OPERATION_CONFLICT', `operation_id ${args.operation_id} 与原剪贴板参数冲突。`);
        }
        return cached.result;
      }
      assertControlAllowed(session);
      const reply = await sendTabCommand(
        session.tab_id,
        'clipboard_set',
        { device_id: session.device_id, text: args.text },
        6_000,
      );
      const result = {
        status: 'applied',
        operation_id: args.operation_id,
        session_id: session.session_id,
        length: args.text.length,
        ...(reply.note ? { note: reply.note } : {}),
      };
      operations.set(opKey, {
        args_hash: argsHash,
        status: 'applied',
        result,
        created_at: now(),
        updated_at: now(),
      });
      return result;
    }
    throw new AgentFailure('INVALID_ARGUMENT', 'clipboard.operation 仅支持 get 或 set。');
  }

  async function handleSelectDisplay(rawBody) {
    const args = validateDisplayArgs(rawBody);
    const session = requireSession(args.session_id);
    abortInFlightAndRelease(session, 'display_switch');
    const reply = await sendTabCommand(
      session.tab_id,
      'select_display',
      { device_id: session.device_id, display_index: args.display_index },
      6_000,
    );
    session.active_display_index = reply.active_display_index ?? args.display_index;
    if (Array.isArray(reply.displays)) session.displays = reply.displays;
    if (reply.source_size?.width > 0 && reply.source_size?.height > 0) {
      session.source_size = reply.source_size;
    }
    session.generation += 1;
    session.geometry_epoch += 1;
    invalidateSessionObservations(session.session_id);
    pushPolicyToTab(session);
    notifyWaiters();
    return buildSessionPublicView(session);
  }

  async function handleDisconnect(rawBody) {
    const session = requireSession(rawBody?.session_id);
    abortInFlightAndRelease(session, 'agent_disconnect');
    await sendTabCommand(
      session.tab_id,
      'disconnect',
      { device_id: session.device_id },
      8_000,
    );
    invalidateSessionObservations(session.session_id);
    sessions.delete(session.session_id);
    notifyWaiters();
    return { ok: true, disconnected: true, session_id: session.session_id };
  }

  async function handleBrowserRequest(req, res, url) {
    try {
      if (req.method === 'GET' && url.pathname === '/__uubridge/agent/capabilities') {
        sendJson(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          agent_bridge: true,
        });
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/__uubridge/agent/events') {
        const tabId = url.searchParams.get('tabId') || randomId('tab');
        validateId(tabId, 'tabId');
        if (tabs.has(tabId)) removeTab(tabId);
        req.socket?.setTimeout?.(0);
        res.setTimeout?.(0);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
        }, 15_000);
        heartbeat.unref?.();
        tabs.set(tabId, { res, connectedAt: now(), lastSeenAt: now(), heartbeat });
        writeSse(res, 'hello', { protocol: PROTOCOL_VERSION, tab_id: tabId });
        req.on('close', () => removeTab(tabId));
        res.on('close', () => removeTab(tabId));
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/__uubridge/agent/state') {
        const body = await readJsonBody(req, 512 * 1024);
        const tabId = validateId(body.tab_id, 'tab_id');
        if (!tabs.has(tabId)) {
          sendJson(res, 409, { error: formatFailure(new AgentFailure('BROWSER_OFFLINE', 'SSE 连接未建立，请重连。')) });
          return true;
        }
        syncTabSessions(tabId, Array.isArray(body.sessions) ? body.sessions : []);
        const policies = {};
        for (const session of sessions.values()) {
          if (session.tab_id === tabId) {
            policies[session.session_id] = buildSessionPublicView(session);
          }
        }
        sendJson(res, 200, { ok: true, policies });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/__uubridge/agent/reply') {
        const body = await readJsonBody(req, 16 * 1024 * 1024);
        const requestId = validateId(body.request_id, 'request_id');
        const pending = pendingCommands.get(requestId);
        if (!pending) {
          sendJson(res, 200, { ok: true, ignored: true });
          return true;
        }
        clearTimeout(pending.timer);
        pendingCommands.delete(requestId);
        if (body.ok) {
          pending.resolve(body.result ?? {});
        } else {
          const err = body.error ?? {};
          pending.reject(
            new AgentFailure(err.code || 'BROWSER_COMMAND_FAILED', err.message || '浏览器执行命令失败。', {
              retryable: Boolean(err.retryable),
              sideEffectPossible: Boolean(err.side_effect_possible),
            }),
          );
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/__uubridge/agent/viewer-control') {
        const body = await readJsonBody(req, 16 * 1024);
        const updated = applyViewerControl(body);
        sendJson(res, 200, { ok: true, session: updated });
        return true;
      }

      return false;
    } catch (error) {
      const fail = formatFailure(error);
      sendJson(res, error instanceof AgentFailure ? error.status : 500, { error: fail });
      return true;
    }
  }

  async function handleAgentRequest(req, res, url) {
    if (!url.pathname.startsWith('/__uubridge/mcp/')) return false;

    // Enforce exact loopback Host and no cross-site browser access.
    const currentOrigin = resolveOrigin();
    const expectedHost = new URL(currentOrigin).host;
    const allowedHosts = new Set([expectedHost, expectedHost.replace('127.0.0.1', 'localhost')]);
    if (!allowedHosts.has(req.headers.host) ||
        (req.headers.origin && req.headers.origin !== currentOrigin) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(res, 403, { error: formatFailure(new AgentFailure('ORIGIN_REJECTED', '仅允许本机回环访问 Agent 接口。')) });
      return true;
    }

    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!matchesSecret(bearer, agentToken)) {
      sendJson(res, 401, { error: formatFailure(new AgentFailure('UNAUTHORIZED', '缺少或无效的 Agent 令牌。')) });
      return true;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/__uubridge/mcp/health') {
        sendJson(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          browser_tabs_connected: tabs.size,
          active_sessions: sessions.size,
        });
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/__uubridge/mcp/sessions') {
        sendJson(res, 200, {
          protocol: PROTOCOL_VERSION,
          browser_tabs_connected: tabs.size,
          sessions: [...sessions.values()].map(buildSessionPublicView),
        });
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/__uubridge/mcp/session') {
        sendJson(res, 200, await handleGetSession(url));
        return true;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        switch (url.pathname) {
          case '/__uubridge/mcp/screenshot':
            sendJson(res, 200, await handleScreenshot(body));
            return true;
          case '/__uubridge/mcp/action':
            sendJson(res, 200, await handleAction(body));
            return true;
          case '/__uubridge/mcp/wait':
            sendJson(res, 200, await handleWait(body));
            return true;
          case '/__uubridge/mcp/release-inputs':
            sendJson(res, 200, await handleReleaseInputs(body));
            return true;
          case '/__uubridge/mcp/control':
            sendJson(res, 200, await handleSetControl(body));
            return true;
          case '/__uubridge/mcp/clipboard':
            sendJson(res, 200, await handleClipboard(body));
            return true;
          case '/__uubridge/mcp/display':
            sendJson(res, 200, await handleSelectDisplay(body));
            return true;
          case '/__uubridge/mcp/disconnect':
            sendJson(res, 200, await handleDisconnect(body));
            return true;
          default:
            sendJson(res, 404, { error: formatFailure(new AgentFailure('NOT_FOUND', '未知的 MCP 接口。')) });
            return true;
        }
      }

      sendJson(res, 405, { error: formatFailure(new AgentFailure('INVALID_ARGUMENT', '不支持的 HTTP 方法。', { status: 405 })) });
      return true;
    } catch (error) {
      const fail = formatFailure(error);
      sendJson(res, error instanceof AgentFailure ? error.status : 500, { error: fail });
      return true;
    }
  }

  function close() {
    for (const tabId of [...tabs.keys()]) removeTab(tabId);
    for (const session of sessions.values()) clearHeldLease(session);
    sessions.clear();
    observations.clear();
    operations.clear();
  }

  return {
    agentToken,
    handleBrowserRequest,
    handleAgentRequest,
    close,
    _debug: { tabs, sessions, observations, operations },
  };
}
