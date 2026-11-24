import { randomBytes } from 'node:crypto';

export const PROTOCOL_VERSION = 'uubridge-agent/1';
export const MAX_OPERATION_CACHE_ENTRIES = 128;
export const OPERATION_CACHE_TTL_MS = 5 * 60 * 1000;
export const MAX_OBSERVATION_ENTRIES = 256;
export const OBSERVATION_TTL_MS = 10 * 60 * 1000;
export const HELD_INPUT_LEASE_MS = 15_000;
export const MAX_SEQUENCE_ACTIONS = 8;
export const MAX_SEQUENCE_DURATION_MS = 8_000;
export const MAX_TEXT_BYTES = 16_384;
export const MAX_CLIPBOARD_READ_BYTES = 128 * 1024;
export const MAX_DRAG_PATH = 128;
export const MAX_WAIT_MS = 25_000;
export const MAX_ACTION_WAIT_MS = 5_000;

export class AgentFailure extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'AgentFailure';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.sideEffectPossible = Boolean(options.sideEffectPossible);
    this.status = options.status ?? statusForCode(code);
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function statusForCode(code) {
  switch (code) {
    case 'INVALID_ARGUMENT':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'ORIGIN_REJECTED':
    case 'CONTROL_DENIED':
    case 'HUMAN_PAUSED':
      return 403;
    case 'SESSION_NOT_FOUND':
    case 'OBSERVATION_NOT_FOUND':
    case 'DISPLAY_NOT_FOUND':
    case 'NOT_FOUND':
      return 404;
    case 'OPERATION_CONFLICT':
    case 'OBSERVATION_STALE':
    case 'SESSION_BUSY':
    case 'SESSION_NOT_READY':
    case 'HELD_INPUT_ACTIVE':
    case 'VIDEO_STALLED':
      return 409;
    case 'BROWSER_OFFLINE':
    case 'WEB_CONTROLLER_UNAVAILABLE':
      return 503;
    case 'TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

export function formatFailure(error) {
  if (error instanceof AgentFailure) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      side_effect_possible: error.sideEffectPossible,
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    side_effect_possible: false,
  };
}

export function randomId(prefix = '') {
  const value = randomBytes(18).toString('base64url');
  return prefix ? `${prefix}_${value}` : value;
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

// Unified key names (aligned with CrossDesk MCP) mapped to Android keycodes used by vendor/uu-web.
// vendor/uu-web automatically translates Android keycodes into macOS / Windows virtual keycodes per target platform.
export const KEY_TO_ANDROID_CODE = Object.freeze({
  // Modifiers
  CTRL: 113,
  CTRL_LEFT: 113,
  CTRL_RIGHT: 114,
  ALT: 57,
  ALT_LEFT: 57,
  ALT_RIGHT: 58,
  SHIFT: 59,
  SHIFT_LEFT: 59,
  SHIFT_RIGHT: 60,
  META: 117,
  META_LEFT: 117,
  META_RIGHT: 118,

  // Navigation & editing
  ENTER: 66,
  TAB: 61,
  SPACE: 62,
  BACKSPACE: 67,
  DELETE: 112,
  ESCAPE: 111,
  UP: 19,
  DOWN: 20,
  LEFT: 21,
  RIGHT: 22,
  HOME: 122,
  END: 123,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  INSERT: 124,
  CAPS_LOCK: 115,
  PRINT_SCREEN: 120,
  NUM_LOCK: 143,

  // Punctuation (US layout keys)
  COMMA: 55,
  PERIOD: 56,
  BACKQUOTE: 68,
  MINUS: 69,
  EQUAL: 70,
  BRACKET_LEFT: 71,
  BRACKET_RIGHT: 72,
  BACKSLASH: 73,
  SEMICOLON: 74,
  QUOTE: 75,
  SLASH: 76,

  // Digits 0-9
  '0': 7,
  '1': 8,
  '2': 9,
  '3': 10,
  '4': 11,
  '5': 12,
  '6': 13,
  '7': 14,
  '8': 15,
  '9': 16,

  // Letters A-Z
  A: 29, B: 30, C: 31, D: 32, E: 33, F: 34, G: 35, H: 36, I: 37, J: 38, K: 39, L: 40, M: 41,
  N: 42, O: 43, P: 44, Q: 45, R: 46, S: 47, T: 48, U: 49, V: 50, W: 51, X: 52, Y: 53, Z: 54,

  // Function keys F1-F12
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136,
  F7: 137, F8: 138, F9: 139, F10: 140, F11: 141, F12: 142,

  // Numpad
  NUMPAD0: 144, NUMPAD1: 145, NUMPAD2: 146, NUMPAD3: 147, NUMPAD4: 148,
  NUMPAD5: 149, NUMPAD6: 150, NUMPAD7: 151, NUMPAD8: 152, NUMPAD9: 153,
  NUMPAD_DIVIDE: 154,
  NUMPAD_MULTIPLY: 155,
  NUMPAD_SUBTRACT: 156,
  NUMPAD_ADD: 157,
  NUMPAD_DOT: 158,
  NUMPAD_ENTER: 160,
});

const KEY_ALIASES = Object.freeze({
  CONTROL: 'CTRL',
  LCTRL: 'CTRL',
  RCTRL: 'CTRL_RIGHT',
  CONTROLLEFT: 'CTRL',
  CONTROLRIGHT: 'CTRL_RIGHT',
  OPTION: 'ALT',
  LALT: 'ALT',
  RALT: 'ALT_RIGHT',
  ALTLEFT: 'ALT',
  ALTRIGHT: 'ALT_RIGHT',
  LSHIFT: 'SHIFT',
  RSHIFT: 'SHIFT_RIGHT',
  SHIFTLEFT: 'SHIFT',
  SHIFTRIGHT: 'SHIFT_RIGHT',
  CMD: 'META',
  COMMAND: 'META',
  WIN: 'META',
  WINDOWS: 'META',
  SUPER: 'META',
  METALEFT: 'META',
  METARIGHT: 'META_RIGHT',
  RETURN: 'ENTER',
  ESC: 'ESCAPE',
  DEL: 'DELETE',
  BS: 'BACKSPACE',
  ARROWUP: 'UP',
  ARROW_UP: 'UP',
  ARROWDOWN: 'DOWN',
  ARROW_DOWN: 'DOWN',
  ARROWLEFT: 'LEFT',
  ARROW_LEFT: 'LEFT',
  ARROWRIGHT: 'RIGHT',
  ARROW_RIGHT: 'RIGHT',
  PGUP: 'PAGE_UP',
  PAGEUP: 'PAGE_UP',
  PGDN: 'PAGE_DOWN',
  PAGEDOWN: 'PAGE_DOWN',
  INS: 'INSERT',
  PRINTSCREEN: 'PRINT_SCREEN',
  CAPSLOCK: 'CAPS_LOCK',
  NUMLOCK: 'NUM_LOCK',
  ' ': 'SPACE',
});

export const MODIFIER_NAMES = new Set(['CTRL', 'ALT', 'SHIFT', 'META']);

export const BUTTON_TO_UU = Object.freeze({
  left: 'primary',
  right: 'secondary',
  middle: 'tertiary',
  back: 'back',
  forward: 'forward',
});

export const HELD_ACTION_TYPES = new Set(['key_down', 'key_up', 'mouse_down', 'mouse_up']);

export function normalizeKeyName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AgentFailure('INVALID_ARGUMENT', '按键名不能为空。');
  }
  const upper = raw.trim().toUpperCase().replace(/-/g, '_');
  const canonical = KEY_ALIASES[upper] ?? upper;
  const code = KEY_TO_ANDROID_CODE[canonical];
  if (code === undefined) {
    throw new AgentFailure('INVALID_ARGUMENT', `不支持的按键名称：${raw}`);
  }
  return { name: canonical, code };
}

export function validateId(value, fieldName = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
    throw new AgentFailure('INVALID_ARGUMENT', `${fieldName} 必须是 1–128 位的有效标识符。`);
  }
  return value;
}

function assertObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentFailure('INVALID_ARGUMENT', `${fieldName} 必须是 JSON 对象。`);
  }
}

function validateInt(value, fieldName, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AgentFailure('INVALID_ARGUMENT', `${fieldName} 必须是 ${min}–${max} 的整数。`);
  }
  return value;
}

function validateModifiers(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 4) {
    throw new AgentFailure('INVALID_ARGUMENT', 'modifiers 最多包含 4 个修饰键。');
  }
  const seen = new Set();
  const list = [];
  for (const item of raw) {
    const { name, code } = normalizeKeyName(item);
    if (!MODIFIER_NAMES.has(name)) {
      throw new AgentFailure('INVALID_ARGUMENT', `modifiers 仅支持 CTRL/ALT/SHIFT/META，收到：${item}`);
    }
    if (seen.has(name)) {
      throw new AgentFailure('INVALID_ARGUMENT', `modifiers 包含重复修饰键：${name}`);
    }
    seen.add(name);
    list.push({ name, code });
  }
  return list;
}

function validateButton(raw, defaultButton = 'left') {
  const value = raw === undefined ? defaultButton : raw;
  if (typeof value !== 'string' || !BUTTON_TO_UU[value]) {
    throw new AgentFailure('INVALID_ARGUMENT', `无效的鼠标按键：${value}`);
  }
  return { button: value, uuButton: BUTTON_TO_UU[value] };
}

function validatePoint(obj, fieldName = 'point') {
  assertObject(obj, fieldName);
  if (typeof obj.x !== 'number' || !Number.isFinite(obj.x) || obj.x < 0 ||
      typeof obj.y !== 'number' || !Number.isFinite(obj.y) || obj.y < 0) {
    throw new AgentFailure('INVALID_ARGUMENT', `${fieldName} 的 x/y 必须是非负有限数字。`);
  }
  return { x: obj.x, y: obj.y };
}

function validateTextPayload(text, fieldName = 'text', maxBytes = MAX_TEXT_BYTES) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new AgentFailure('INVALID_ARGUMENT', `${fieldName} 不能为空。`);
  }
  if (text.includes('\0')) {
    throw new AgentFailure('INVALID_ARGUMENT', `${fieldName} 不能包含 NUL 字符。`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new AgentFailure('INVALID_ARGUMENT', `${fieldName} 超出 ${maxBytes} 字节上限。`);
  }
  return text;
}

export function validateScreenshotArgs(raw) {
  assertObject(raw, 'screenshot');
  const session_id = validateId(raw.session_id, 'session_id');
  let region;
  if (raw.region !== undefined) {
    assertObject(raw.region, 'region');
    region = {
      x: validateInt(raw.region.x, 'region.x', 0, 16384),
      y: validateInt(raw.region.y, 'region.y', 0, 16384),
      width: validateInt(raw.region.width, 'region.width', 1, 16384),
      height: validateInt(raw.region.height, 'region.height', 1, 16384),
    };
    if (region.x === undefined || region.y === undefined || region.width === undefined || region.height === undefined) {
      throw new AgentFailure('INVALID_ARGUMENT', 'region 必须包含完整的 x, y, width, height 整数。');
    }
  }
  const max_edge = validateInt(raw.max_edge, 'max_edge', 64, 2048, 1280);
  const after_frame_id = validateInt(raw.after_frame_id, 'after_frame_id', 0, Number.MAX_SAFE_INTEGER);
  const generation = validateInt(raw.generation, 'generation', 0, Number.MAX_SAFE_INTEGER);
  if (after_frame_id !== undefined && generation === undefined) {
    throw new AgentFailure('INVALID_ARGUMENT', '提供 after_frame_id 时必须同时提供 generation。');
  }
  const timeout_ms = validateInt(raw.timeout_ms, 'timeout_ms', 0, 5_000, 2_000);
  return { session_id, ...(region ? { region } : {}), max_edge, ...(after_frame_id !== undefined ? { after_frame_id, generation } : {}), timeout_ms };
}

export function validateSingleAction(raw, { allowHeld = true } = {}) {
  assertObject(raw, 'action');
  const type = raw.type;
  if (typeof type !== 'string') {
    throw new AgentFailure('INVALID_ARGUMENT', 'action.type 必填。');
  }
  if (!allowHeld && HELD_ACTION_TYPES.has(type)) {
    throw new AgentFailure('INVALID_ARGUMENT', `sequence 中不允许使用 ${type}。`);
  }
  switch (type) {
    case 'move': {
      const { x, y } = validatePoint(raw, 'move');
      return { type, x, y, modifiers: validateModifiers(raw.modifiers) };
    }
    case 'mouse_down':
    case 'mouse_up': {
      const { x, y } = validatePoint(raw, type);
      const { button, uuButton } = validateButton(raw.button, 'left');
      return { type, x, y, button, uuButton };
    }
    case 'click':
    case 'double_click': {
      const { x, y } = validatePoint(raw, type);
      const { button, uuButton } = validateButton(raw.button, 'left');
      return { type, x, y, button, uuButton, modifiers: validateModifiers(raw.modifiers) };
    }
    case 'scroll': {
      const { x, y } = validatePoint(raw, 'scroll');
      if (!['up', 'down', 'left', 'right'].includes(raw.direction)) {
        throw new AgentFailure('INVALID_ARGUMENT', 'scroll.direction 必须是 up/down/left/right。');
      }
      const ticks = validateInt(raw.ticks, 'scroll.ticks', 1, 10, 3);
      return { type, x, y, direction: raw.direction, ticks, modifiers: validateModifiers(raw.modifiers) };
    }
    case 'drag': {
      if (!Array.isArray(raw.path) || raw.path.length < 2 || raw.path.length > MAX_DRAG_PATH) {
        throw new AgentFailure('INVALID_ARGUMENT', `drag.path 必须包含 2–${MAX_DRAG_PATH} 个坐标点。`);
      }
      const path = raw.path.map((pt, idx) => validatePoint(pt, `drag.path[${idx}]`));
      const duration_ms = validateInt(raw.duration_ms, 'drag.duration_ms', 100, 30_000, 300);
      const { button, uuButton } = validateButton(raw.button, 'left');
      return { type, path, duration_ms, button, uuButton, modifiers: validateModifiers(raw.modifiers) };
    }
    case 'key_down':
    case 'key_up': {
      const key = normalizeKeyName(raw.key);
      return { type, key: key.name, keyCode: key.code };
    }
    case 'key_press': {
      const key = normalizeKeyName(raw.key);
      const modifiers = validateModifiers(raw.modifiers);
      if (modifiers.some((m) => m.name === key.name)) {
        throw new AgentFailure('INVALID_ARGUMENT', `key_press 的 modifiers 不能包含按键自身：${key.name}`);
      }
      const duration_ms = validateInt(raw.duration_ms, 'key_press.duration_ms', 10, 30_000, 35);
      return { type, key: key.name, keyCode: key.code, modifiers, duration_ms };
    }
    case 'hotkey': {
      if (!Array.isArray(raw.keys) || raw.keys.length < 2 || raw.keys.length > 6) {
        throw new AgentFailure('INVALID_ARGUMENT', 'hotkey.keys 必须包含 2–6 个不重复按键。');
      }
      const seen = new Set();
      const keys = raw.keys.map((k) => {
        const parsed = normalizeKeyName(k);
        if (seen.has(parsed.name)) throw new AgentFailure('INVALID_ARGUMENT', `hotkey 包含重复按键：${parsed.name}`);
        seen.add(parsed.name);
        return parsed;
      });
      const duration_ms = validateInt(raw.duration_ms, 'hotkey.duration_ms', 10, 30_000, 40);
      return { type, keys, duration_ms };
    }
    case 'type_text': {
      const text = validateTextPayload(raw.text, 'type_text.text', MAX_TEXT_BYTES);
      return { type, text };
    }
    default:
      throw new AgentFailure('INVALID_ARGUMENT', `不支持的动作类型：${type}`);
  }
}

export function validateActionSpec(raw) {
  assertObject(raw, 'action');
  if (raw.type !== 'sequence') {
    return validateSingleAction(raw, { allowHeld: true });
  }
  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > MAX_SEQUENCE_ACTIONS) {
    throw new AgentFailure('INVALID_ARGUMENT', `sequence.actions 必须包含 1–${MAX_SEQUENCE_ACTIONS} 个子动作。`);
  }
  const interval_ms = validateInt(raw.interval_ms, 'sequence.interval_ms', 0, 500, 100);
  const actions = raw.actions.map((item) => {
    if (item?.type === 'sequence') {
      throw new AgentFailure('INVALID_ARGUMENT', 'sequence 不允许嵌套。');
    }
    return validateSingleAction(item, { allowHeld: false });
  });
  let totalTextBytes = 0;
  let plannedDuration = interval_ms * Math.max(0, actions.length - 1);
  for (const item of actions) {
    if (item.type === 'type_text') totalTextBytes += Buffer.byteLength(item.text, 'utf8');
    if (item.duration_ms) plannedDuration += item.duration_ms;
  }
  if (totalTextBytes > MAX_TEXT_BYTES) {
    throw new AgentFailure('INVALID_ARGUMENT', `sequence 文本总长度不能超过 ${MAX_TEXT_BYTES} 字节。`);
  }
  if (plannedDuration > MAX_SEQUENCE_DURATION_MS) {
    throw new AgentFailure('INVALID_ARGUMENT', `sequence 计划总时长 ${plannedDuration}ms 超出 ${MAX_SEQUENCE_DURATION_MS}ms 上限。`);
  }
  return { type: 'sequence', actions, interval_ms };
}

export function validateActionWait(raw) {
  if (raw === undefined) return undefined;
  assertObject(raw, 'wait');
  if (!['changed', 'stable'].includes(raw.condition)) {
    throw new AgentFailure('INVALID_ARGUMENT', 'wait.condition 仅支持 changed 或 stable。');
  }
  const observation_id = raw.observation_id !== undefined ? validateId(raw.observation_id, 'wait.observation_id') : undefined;
  const stable_ms = validateInt(raw.stable_ms, 'wait.stable_ms', 100, 5_000, 200);
  const timeout_ms = validateInt(raw.timeout_ms, 'wait.timeout_ms', 0, MAX_ACTION_WAIT_MS, 1_000);
  return { condition: raw.condition, ...(observation_id ? { observation_id } : {}), stable_ms, timeout_ms };
}

export function validateActionRequest(raw) {
  assertObject(raw, 'actionRequest');
  const session_id = validateId(raw.session_id, 'session_id');
  const operation_id = validateId(raw.operation_id, 'operation_id');
  const observation_id = validateId(raw.observation_id, 'observation_id');
  const action = validateActionSpec(raw.action);
  const observe_after = raw.observe_after === undefined ? true : Boolean(raw.observe_after);
  if (raw.wait !== undefined && !observe_after) {
    throw new AgentFailure('INVALID_ARGUMENT', 'observe_after=false 时不能提供 wait。');
  }
  const wait = validateActionWait(raw.wait);
  return { session_id, operation_id, observation_id, action, observe_after, ...(wait ? { wait } : {}) };
}

export function validateWaitArgs(raw) {
  assertObject(raw, 'wait');
  const session_id = validateId(raw.session_id, 'session_id');
  const observation_id = validateId(raw.observation_id, 'observation_id');
  if (!['changed', 'stable'].includes(raw.condition)) {
    throw new AgentFailure('INVALID_ARGUMENT', 'condition 必须是 changed 或 stable。');
  }
  const stable_ms = validateInt(raw.stable_ms, 'stable_ms', 100, 5_000, 500);
  const timeout_ms = validateInt(raw.timeout_ms, 'timeout_ms', 0, MAX_WAIT_MS, 5_000);
  return { session_id, observation_id, condition: raw.condition, stable_ms, timeout_ms };
}

export function validateClipboardSetArgs(raw) {
  assertObject(raw, 'clipboardSet');
  const session_id = validateId(raw.session_id, 'session_id');
  const operation_id = validateId(raw.operation_id, 'operation_id');
  if (typeof raw.text !== 'string') {
    throw new AgentFailure('INVALID_ARGUMENT', 'text 必须是字符串。');
  }
  if (raw.text.includes('\0') || Buffer.byteLength(raw.text, 'utf8') > MAX_TEXT_BYTES) {
    throw new AgentFailure('INVALID_ARGUMENT', `text 不能包含 NUL 且不超过 ${MAX_TEXT_BYTES} 字节。`);
  }
  return { session_id, operation_id, text: raw.text };
}

export function validateDisplayArgs(raw) {
  assertObject(raw, 'display');
  const session_id = validateId(raw.session_id, 'session_id');
  const display_index = validateInt(raw.display_index, 'display_index', 0, 63);
  if (display_index === undefined) {
    throw new AgentFailure('INVALID_ARGUMENT', 'display_index 必须是 0–63 的整数。');
  }
  return { session_id, display_index };
}

export function validateControlArgs(raw) {
  assertObject(raw, 'control');
  const session_id = validateId(raw.session_id, 'session_id');
  if (typeof raw.enabled !== 'boolean') {
    throw new AgentFailure('INVALID_ARGUMENT', 'enabled 必须是布尔值。');
  }
  return { session_id, enabled: raw.enabled };
}

export function mapObservationPointToSource(observation, x, y) {
  const imgW = observation.image_size?.width ?? 0;
  const imgH = observation.image_size?.height ?? 0;
  const srcW = observation.source_size?.width ?? 0;
  const srcH = observation.source_size?.height ?? 0;
  if (imgW <= 0 || imgH <= 0 || srcW <= 0 || srcH <= 0) {
    throw new AgentFailure('OBSERVATION_STALE', '观测图像尺寸无效，请重新截屏。');
  }
  if (x < 0 || x > imgW || y < 0 || y > imgH) {
    throw new AgentFailure(
      'INVALID_ARGUMENT',
      `坐标 (${x}, ${y}) 超出观测图像范围 (${imgW} × ${imgH})。`,
    );
  }
  const region = observation.region ?? { x: 0, y: 0, width: srcW, height: srcH };
  const normX = imgW === 1 ? 0 : x / imgW;
  const normY = imgH === 1 ? 0 : y / imgH;
  const absX = Math.min(srcW, Math.max(0, region.x + normX * region.width));
  const absY = Math.min(srcH, Math.max(0, region.y + normY * region.height));
  return {
    absX: Math.round(absX * 100) / 100,
    absY: Math.round(absY * 100) / 100,
    surfaceWidth: srcW,
    surfaceHeight: srcH,
  };
}

function resolveSingleActionPlan(action, observation) {
  switch (action.type) {
    case 'move':
    case 'click':
    case 'double_click':
    case 'mouse_down':
    case 'mouse_up':
    case 'scroll': {
      const mapped = mapObservationPointToSource(observation, action.x, action.y);
      return { ...action, ...mapped };
    }
    case 'drag': {
      const mappedPath = action.path.map((pt) => mapObservationPointToSource(observation, pt.x, pt.y));
      return { ...action, mappedPath };
    }
    default:
      return { ...action };
  }
}

export function resolveActionPlan(action, observation) {
  if (action.type === 'sequence') {
    return {
      type: 'sequence',
      interval_ms: action.interval_ms,
      actions: action.actions.map((item) => resolveSingleActionPlan(item, observation)),
    };
  }
  return resolveSingleActionPlan(action, observation);
}

export function summarizeAction(action) {
  if (action.type === 'sequence') {
    return `sequence(${action.actions.length}: ${action.actions.map((a) => a.type).join(' → ')})`;
  }
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'move':
    case 'mouse_down':
    case 'mouse_up':
      return `${action.type}${action.button && action.button !== 'left' ? `:${action.button}` : ''} (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'scroll':
      return `scroll ${action.direction}×${action.ticks} (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'drag':
      return `drag (${action.path.length}点, ${action.duration_ms}ms)`;
    case 'key_press':
    case 'key_down':
    case 'key_up':
      return `${action.type} ${[...(action.modifiers ?? []).map((m) => m.name), action.key].join('+')}`;
    case 'hotkey':
      return `hotkey ${action.keys.map((k) => k.name).join('+')}`;
    case 'type_text':
      return `type_text (${action.text.length}字)`;
    default:
      return action.type;
  }
}
