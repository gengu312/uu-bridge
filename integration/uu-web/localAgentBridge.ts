import type { StreamerMouseButtonKind } from "@uurc/shared/streamer/inputDesktop";
import { STREAMER_DATA_CHANNEL_LABELS } from "@uurc/shared/streamer/transport";

import { teardownRemoteConnection } from "./controllers/teardownRemoteConnection.js";
import type { BrowserRemoteSession } from "./remote/browserRemoteSession.js";
import { listConnections } from "./remote/remoteConnectionsStore.js";
import { isDesktopRemoteScrollTarget } from "./remote/remoteScrollInput.js";
import { addRemoteClipboardObserver } from "./remote/remoteSessionEventBridge.js";
import { getRemoteSession, getRemoteSessionState } from "./remote/remoteSessionStore.js";
import { getRemoteVideoStreams } from "./remote/remoteVideoStreamsStore.js";

interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MappedPoint {
  absX: number;
  absY: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

interface KeySpec {
  name: string;
  code: number;
}

type SingleActionPlan =
  | { type: "move"; absX: number; absY: number; surfaceWidth: number; surfaceHeight: number; modifiers: KeySpec[] }
  | { type: "mouse_down" | "mouse_up"; absX: number; absY: number; surfaceWidth: number; surfaceHeight: number; uuButton: StreamerMouseButtonKind }
  | { type: "click" | "double_click"; absX: number; absY: number; surfaceWidth: number; surfaceHeight: number; uuButton: StreamerMouseButtonKind; modifiers: KeySpec[] }
  | { type: "scroll"; absX: number; absY: number; surfaceWidth: number; surfaceHeight: number; direction: "up" | "down" | "left" | "right"; ticks: number; modifiers: KeySpec[] }
  | { type: "drag"; mappedPath: MappedPoint[]; duration_ms: number; uuButton: StreamerMouseButtonKind; modifiers: KeySpec[] }
  | { type: "key_down" | "key_up"; key: string; keyCode: number }
  | { type: "key_press"; key: string; keyCode: number; modifiers: KeySpec[]; duration_ms: number }
  | { type: "hotkey"; keys: KeySpec[]; duration_ms: number }
  | { type: "type_text"; text: string };

type ActionPlan =
  | SingleActionPlan
  | { type: "sequence"; interval_ms: number; actions: SingleActionPlan[] };

interface ActionWaitSpec {
  condition: "changed" | "stable" | "frame";
  baseline_snapshot_id?: string | null;
  region?: RegionRect;
  max_edge?: number;
  stable_ms?: number;
  timeout_ms?: number;
}

interface BrokerPolicy {
  session_id: string;
  device_id: string;
  authorized: boolean;
  human_paused: boolean;
  auto_pause_on_human_input: boolean;
  agent_control_enabled: boolean;
  control_allowed: boolean;
  busy: boolean;
  has_held_inputs: boolean;
  last_action?: { at: number; type: string; summary: string; status: string } | null;
}

interface AgentCommandMessage {
  request_id: string;
  method: string;
  params: Record<string, unknown>;
}

interface FrameFingerprint {
  width: number;
  height: number;
  region: RegionRect;
  pixels: Uint8Array;
  capturedAt: number;
}

const SAMPLE_WIDTH = 160;
const SAMPLE_HEIGHT = 90;
const MAX_SNAPSHOT_CACHE = 64;
const SCROLL_STEP_PER_TICK = 60;
const THEME_STORAGE_KEY = "uubridge.theme";
const THEME_STYLE_ID = "uubridge-theme-override";

type ThemeMode = "system" | "light" | "dark";

const PAGE_LAYOUT_POLISH_CSS = `
/* 提高画面利用率：单设备连接时隐藏与顶栏重复的页签条，多设备时自动保留；收紧顶栏与侧栏宽度。 */
.control-shell > .remote-connection-tabs:has(.remote-connection-tab:only-child) {
  display: none !important;
}
.control-shell > .control-topbar {
  min-height: 42px;
  padding: 0 10px;
}
.control-side-panel {
  flex: 0 0 272px;
}
.control-side-panel .tabs-panel {
  padding: 12px;
}
.control-side-panel .segmented-control {
  gap: 3px;
  padding: 4px;
}
.control-side-panel .segmented-control-label {
  min-height: 28px;
  padding: 0 3px;
  font-size: 11.5px;
  white-space: nowrap;
}
`;

const PAGE_LIGHT_THEME_CSS = `
${PAGE_LAYOUT_POLISH_CSS}
:root {
  color-scheme: light;
}
.control-shell {
  --stage: #e9edf3;
  --dark-bg: #f4f6f9;
  --dark-bg-pure: #e9edf3;
  --dark-panel: #ffffff;
  --dark-border: #dde3ec;
  --dark-surface-1: #f8fafc;
  --dark-surface-2: #edf2f7;
  --dark-text: #0f172a;
  --dark-text-muted: #475569;
  --dark-text-dim: #64748b;
  --dark-toolbar-bg: rgba(255, 255, 255, 0.94);
  --dark-scrim: rgba(15, 23, 42, 0.22);
  --dark-success: #15803d;
  --dark-success-dot: #16a34a;
  --dark-success-bg: #f0fdf4;
  --dark-warn: #b45309;
  --dark-warn-dot: #d97706;
  --dark-warn-bg: #fffbeb;
  --dark-idle-dot: #64748b;
  --dark-idle-bg: #e2e8f0;
  --dark-danger: #dc2626;
}
.control-shell > .remote-connection-tabs {
  background: #ffffff !important;
  border-color: #dde3ec !important;
}
.control-shell > .remote-connection-tabs .remote-connection-tabs-label {
  color: #64748b !important;
}
.control-shell > .remote-connection-tabs .remote-connection-tab {
  border-color: #cbd5e1 !important;
  background: #f8fafc !important;
  color: #0f172a !important;
}
.control-shell > .remote-connection-tabs .remote-connection-tab.is-active {
  border-color: #2563eb !important;
  background: #eff6ff !important;
  color: #1d4ed8 !important;
}
.control-topbar--overlay {
  background: rgba(255, 255, 255, 0.92) !important;
}
.control-command-bar {
  color: var(--dark-text) !important;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12) !important;
}
.control-command-bar--docked {
  background: #f1f5f9 !important;
  box-shadow: none !important;
}
.control-command-bar button,
.shortcut-menu > summary {
  color: #334155 !important;
}
.control-command-bar button:hover:not(:disabled),
.shortcut-menu > summary:hover {
  border-color: #cbd5e1 !important;
  background: #e2e8f0 !important;
  color: #0f172a !important;
}
.control-command-bar .remote-audio-button.is-attention:not(:disabled) {
  border-color: #f59e0b !important;
  background: #fef3c7 !important;
  color: #b45309 !important;
}
.control-command-bar .primary-action-button,
.control-command-bar .control-mode-switch button.is-active {
  color: #ffffff !important;
}
.control-command-bar .control-mode-switch {
  background: #e2e8f0 !important;
  border-color: #cbd5e1 !important;
}
.control-command-bar .control-mode-switch button {
  color: #475569 !important;
}
.control-command-bar .control-mode-switch button:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.06) !important;
  color: #0f172a !important;
}
.control-command-bar .operation-note,
.shortcut-menu-chevron,
.shortcut-menu-group h3 {
  color: #64748b !important;
}
.control-command-bar .remote-input-row input {
  border-color: #cbd5e1 !important;
  background: #ffffff !important;
  color: #0f172a !important;
}
.control-command-bar .remote-input-row input::placeholder {
  color: #94a3b8 !important;
}
.shortcut-menu-panel,
.screen-picker-panel {
  border-color: #dde3ec !important;
  background: rgba(255, 255, 255, 0.98) !important;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.14) !important;
}
.screen-picker-panel button.is-active {
  color: #1d4ed8 !important;
  background: #eff6ff !important;
}
.video-source-silent-toggle {
  border-color: #cbd5e1 !important;
  background: #f1f5f9 !important;
  color: #475569 !important;
}
.video-source-silent-toggle:hover,
.video-source-silent-toggle:focus-visible {
  background: #e2e8f0 !important;
  color: #0f172a !important;
}
.reconnect-banner {
  background: rgba(255, 251, 235, 0.96) !important;
  border-color: #fcd34d !important;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12) !important;
}
.control-shell .remote-stage,
.control-shell .remote-video-grid,
.control-shell .remote-video-tile,
.control-shell .remote-video {
  background: #e9edf3 !important;
}
.control-shell .remote-stage {
  border-color: #cbd5e1;
}
.control-shell .stage-center,
.control-shell .stage-center strong {
  color: #1e293b !important;
}
.control-shell .stage-center span {
  color: #64748b !important;
}
`;

const PAGE_DARK_THEME_CSS = `
${PAGE_LAYOUT_POLISH_CSS}
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --surface: #171a21;
  --surface-2: #1f242e;
  --surface-hover: #262c38;
  --border: #2b313e;
  --border-soft: #202530;
  --border-strong: #3b4455;
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --text-dim: #64748b;
  --accent: #3b82f6;
  --accent-hover: #2563eb;
  --accent-soft: rgba(59, 130, 246, 0.16);
  --accent-soft-border: rgba(59, 130, 246, 0.36);
  --success: #4ade80;
  --success-soft: rgba(22, 163, 74, 0.16);
  --success-border: rgba(74, 222, 128, 0.32);
  --warn: #fbbf24;
  --warn-soft: rgba(217, 119, 6, 0.18);
  --warn-border: rgba(251, 191, 36, 0.34);
  --danger: #f87171;
  --danger-soft: rgba(220, 38, 38, 0.16);
  --danger-border: rgba(248, 113, 113, 0.36);
  --gray-600: #cbd5e1;
  --gray-500: #94a3b8;
  --gray-450: #94a3b8;
  --gray-400: #64748b;
  --gray-350: #475569;
  --gray-300: #334155;
}
.landing-shell {
  background: var(--bg) !important;
  color: var(--text) !important;
}
.landing-header {
  background: rgba(15, 17, 21, 0.88) !important;
  border-bottom-color: var(--border) !important;
}
.landing-shell h1,
.landing-shell h2,
.landing-shell h3,
.landing-shell strong,
.landing-brand-name {
  color: var(--text) !important;
}
.landing-shell p,
.landing-nav a {
  color: var(--text-muted) !important;
}
.landing-card,
.landing-feature-card,
.landing-step-card {
  background: var(--surface) !important;
  border-color: var(--border) !important;
}
`;

class BridgeCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly sideEffectPossible = false,
  ) {
    super(message);
  }
}

let started = false;

export async function startLocalAgentBridge(): Promise<void> {
  if (started || typeof window === "undefined" || typeof document === "undefined") return;
  started = true;

  // Only activate when running behind UUBridge's local-run.mjs wrapper.
  try {
    const response = await fetch("/__uubridge/agent/capabilities", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { agent_bridge?: boolean };
    if (!payload.agent_bridge) return;
  } catch {
    return;
  }

  new LocalAgentBridgeRuntime().start();
}

export function resetLocalAgentBridgeForTest(): void {
  started = false;
}

export class LocalAgentBridgeRuntime {
  private readonly tabId = `tab_${Math.random().toString(36).slice(2, 12)}_${Date.now().toString(36)}`;
  private eventSource: EventSource | null = null;
  private reconnectTimer: number | null = null;
  private syncTimer: number | null = null;
  private mountCheckRaf: number | null = null;
  private lastStateDigest = "";
  private lastRenderKey = "";
  private lastSyncAt = 0;
  private snapshotSeq = 0;
  private sampleCanvas: HTMLCanvasElement | null = null;

  private readonly policies = new Map<string, BrokerPolicy>();
  private readonly displayIndexByDevice = new Map<string, number>();
  private readonly offscreenVideos = new Map<string, HTMLVideoElement>();
  private readonly snapshots = new Map<string, FrameFingerprint>();
  private readonly heldKeysByDevice = new Map<string, Set<number>>();
  private readonly heldButtonsByDevice = new Map<string, Set<StreamerMouseButtonKind>>();
  private readonly activeAbortByDevice = new Map<string, AbortController>();
  private readonly sessionInstanceIds = new WeakMap<BrowserRemoteSession, string>();
  private readonly clipboardByDevice = new Map<string, { text: string; at: number }>();
  private readonly clipboardWaiters = new Map<string, Set<(text: string) => void>>();

  private uiHost: HTMLDivElement | null = null;
  private uiRoot: ShadowRoot | null = null;
  private uiCollapsed = false;
  private dockedInSidebar = false;
  private domObserver: MutationObserver | null = null;
  private sseConnected = false;
  private themeMode: ThemeMode = "system";
  private colorSchemeMedia: MediaQueryList | null = null;
  private onColorSchemeChange: (() => void) | null = null;
  private barPosition: { left: number; top: number } | null = null;

  start(): void {
    addRemoteClipboardObserver((deviceId, text) => {
      this.clipboardByDevice.set(deviceId, { text, at: Date.now() });
      const waiters = this.clipboardWaiters.get(deviceId);
      if (waiters) {
        for (const resolve of waiters) resolve(text);
        waiters.clear();
      }
    });

    this.initTheme();
    this.mountControlBar();
    this.observeSidebarMount();
    this.installHumanTakeoverListener();
    this.connectEvents();
    this.syncTimer = window.setInterval(() => {
      void this.syncState(false);
    }, 1500);
    window.addEventListener("beforeunload", () => {
      this.cleanup();
    });
  }

  stop(): void {
    this.cleanup();
    this.domObserver?.disconnect();
    this.domObserver = null;
    if (this.mountCheckRaf !== null) {
      window.cancelAnimationFrame(this.mountCheckRaf);
      this.mountCheckRaf = null;
    }
    if (this.colorSchemeMedia && this.onColorSchemeChange) {
      this.colorSchemeMedia.removeEventListener?.("change", this.onColorSchemeChange);
    }
    this.colorSchemeMedia = null;
    this.onColorSchemeChange = null;
    document.getElementById(THEME_STYLE_ID)?.remove();
    delete document.documentElement.dataset.uubridgeTheme;
    this.uiHost?.remove();
    this.uiHost = null;
    this.uiRoot = null;
  }

  private cleanup(): void {
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.eventSource?.close();
    for (const controller of this.activeAbortByDevice.values()) controller.abort();
    for (const video of this.offscreenVideos.values()) {
      video.srcObject = null;
      video.remove();
    }
    this.offscreenVideos.clear();
  }

  private connectEvents(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    const es = new EventSource(`/__uubridge/agent/events?tabId=${encodeURIComponent(this.tabId)}`);
    this.eventSource = es;

    es.addEventListener("hello", () => {
      this.sseConnected = true;
      void this.syncState(true);
      this.renderBar();
    });

    es.addEventListener("policy", (event) => {
      try {
        const policy = JSON.parse((event as MessageEvent<string>).data) as BrokerPolicy;
        if (policy.session_id) {
          this.policies.set(policy.session_id, policy);
          this.renderBar();
        }
      } catch {
        // Ignore malformed SSE event.
      }
    });

    es.addEventListener("command", (event) => {
      try {
        const command = JSON.parse((event as MessageEvent<string>).data) as AgentCommandMessage;
        void this.handleCommand(command);
      } catch {
        // Ignore malformed command.
      }
    });

    es.onerror = () => {
      this.sseConnected = false;
      this.renderBar();
      es.close();
      if (this.eventSource === es) this.eventSource = null;
      if (this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connectEvents();
        }, 1500);
      }
    };
  }

  private getSessionInstanceId(session: BrowserRemoteSession): string {
    let id = this.sessionInstanceIds.get(session);
    if (!id) {
      id = `inst_${Math.random().toString(36).slice(2, 10)}`;
      this.sessionInstanceIds.set(session, id);
    }
    return id;
  }

  private resolveTargetPlatform(deviceId: string): number | undefined {
    const session = getRemoteSession(deviceId);
    const fromSession = session?.getTargetPlatform();
    if (typeof fromSession === "number") return fromSession;
    const conn = listConnections().find((item) => item.deviceId === deviceId);
    if (!conn) return undefined;
    const join = conn.handoff.roomJoinContext;
    if (typeof join.targetPlatform === "number") return join.targetPlatform;
    return undefined;
  }

  private findVideoElement(deviceId: string, displayIndex: number, allowOffscreen = true): HTMLVideoElement | null {
    const streams = getRemoteVideoStreams(deviceId);
    const chosen = streams[displayIndex] ?? streams[0];
    if (chosen) {
      const domVideos = document.querySelectorAll<HTMLVideoElement>("video.remote-video");
      for (const video of domVideos) {
        if (video.srcObject === chosen.stream) return video;
      }
      if (!allowOffscreen) return null;
      // Fallback: maintain an offscreen video element only when an Agent actively queries a background display.
      const cacheKey = `${deviceId}::${chosen.id}`;
      let offscreen = this.offscreenVideos.get(cacheKey);
      if (!offscreen || offscreen.srcObject !== chosen.stream) {
        if (offscreen) {
          offscreen.srcObject = null;
          offscreen.remove();
        }
        offscreen = document.createElement("video");
        offscreen.muted = true;
        offscreen.autoplay = true;
        offscreen.playsInline = true;
        offscreen.style.position = "fixed";
        offscreen.style.width = "1px";
        offscreen.style.height = "1px";
        offscreen.style.opacity = "0";
        offscreen.style.pointerEvents = "none";
        offscreen.style.left = "-9999px";
        offscreen.srcObject = chosen.stream;
        document.body.appendChild(offscreen);
        void offscreen.play().catch(() => undefined);
        this.offscreenVideos.set(cacheKey, offscreen);
      }
      return offscreen;
    }

    const activeDomVideo = document.querySelector<HTMLVideoElement>('video.remote-video[data-active="true"]');
    return activeDomVideo;
  }

  private async ensureVideoReady(deviceId: string, displayIndex: number, timeoutMs = 2000): Promise<HTMLVideoElement> {
    const deadline = Date.now() + Math.max(200, timeoutMs);
    while (Date.now() <= deadline) {
      const video = this.findVideoElement(deviceId, displayIndex);
      if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        return video;
      }
      await sleep(50);
    }
    throw new BridgeCommandError("SESSION_NOT_READY", "远端视频画面尚未解码就绪，请等待画面出现后重试。", true, false);
  }

  private getFrameId(video: HTMLVideoElement, stateFrameCount?: number): number {
    const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
    if (quality && Number.isFinite(quality.totalVideoFrames)) return Math.trunc(quality.totalVideoFrames);
    if (typeof stateFrameCount === "number" && Number.isFinite(stateFrameCount)) return Math.trunc(stateFrameCount);
    return Math.round(video.currentTime * 60);
  }

  private collectSessionsSnapshot(): Array<Record<string, unknown>> {
    const connections = listConnections();
    const result: Array<Record<string, unknown>> = [];

    for (const conn of connections) {
      const session = getRemoteSession(conn.deviceId);
      const state = getRemoteSessionState(conn.deviceId);
      const streams = getRemoteVideoStreams(conn.deviceId);
      const activeIdx = Math.min(this.displayIndexByDevice.get(conn.deviceId) ?? 0, Math.max(0, streams.length - 1));
      const video = this.findVideoElement(conn.deviceId, activeIdx, false);
      const width = video?.videoWidth || state.videoElement?.width || state.inboundVideo?.frameWidth || 0;
      const height = video?.videoHeight || state.videoElement?.height || state.inboundVideo?.frameHeight || 0;
      const videoReady = Boolean((video && video.readyState >= 2 && width > 0 && height > 0) || (width > 0 && height > 0 && state.stage === "connected"));
      const videoStalled = state.videoFlow?.status === "transport_stalled" || state.videoFlow?.status === "decode_stalled";
      const frameId = video ? this.getFrameId(video, state.videoElement?.totalVideoFrames) : (state.videoElement?.totalVideoFrames ?? 0);

      const displays = streams.map((item, index) => {
        const track = item.stream.getVideoTracks()[0];
        const settings = typeof track?.getSettings === "function" ? track.getSettings() : undefined;
        return {
          index,
          id: item.id,
          width: settings?.width ?? (index === activeIdx ? width : 0),
          height: settings?.height ?? (index === activeIdx ? height : 0),
          active: index === activeIdx,
          ended: track?.readyState === "ended",
        };
      });

      result.push({
        device_id: conn.deviceId,
        device_name: conn.deviceName || conn.deviceId,
        stage: state.stage,
        target_platform: this.resolveTargetPlatform(conn.deviceId),
        source_size: { width, height },
        displays,
        active_display_index: activeIdx,
        frame_id: frameId,
        video_ready: videoReady,
        video_stalled: videoStalled,
        control_channel_open: state.dataChannels[STREAMER_DATA_CHANNEL_LABELS.control] === "open",
        text_channel_open: state.dataChannels[STREAMER_DATA_CHANNEL_LABELS.text] === "open",
        file_channel_open: state.dataChannels[STREAMER_DATA_CHANNEL_LABELS.file] === "open",
        session_instance_id: session ? this.getSessionInstanceId(session) : "",
      });
    }
    return result;
  }

  private async syncState(force: boolean): Promise<void> {
    if (!this.sseConnected) return;
    const sessions = this.collectSessionsSnapshot();
    // Exclude volatile per-frame counters from the change digest so idle video playback
    // does not trigger nonstop state POSTs or Shadow DOM rebuilds.
    const digest = JSON.stringify(
      sessions.map((item) => {
        const { frame_id: _frameId, ...structural } = item;
        return structural;
      }),
    );
    const now = Date.now();
    if (!force && digest === this.lastStateDigest && now - this.lastSyncAt < 15000) return;
    this.lastStateDigest = digest;
    this.lastSyncAt = now;

    try {
      const response = await fetch("/__uubridge/agent/state", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tab_id: this.tabId, sessions }),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { policies?: Record<string, BrokerPolicy> };
      if (data.policies) {
        const liveIds = new Set(Object.keys(data.policies));
        for (const id of [...this.policies.keys()]) {
          if (!liveIds.has(id)) this.policies.delete(id);
        }
        for (const [id, policy] of Object.entries(data.policies)) {
          this.policies.set(id, policy);
        }
        this.renderBar();
      }
    } catch {
      // Transient local network error; retried on next tick.
    }
  }

  private async postReply(requestId: string, ok: boolean, payload: unknown): Promise<void> {
    try {
      await fetch("/__uubridge/agent/reply", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ok ? { request_id: requestId, ok: true, result: payload } : { request_id: requestId, ok: false, error: payload }),
      });
    } catch {
      // Ignore reply transport failures; broker timeout handles cleanup.
    }
  }

  private async handleCommand(command: AgentCommandMessage): Promise<void> {
    try {
      let result: unknown;
      switch (command.method) {
        case "screenshot":
          result = await this.execScreenshot(command.params);
          break;
        case "action":
          result = await this.execAction(command.params);
          break;
        case "wait":
          result = await this.execWait(command.params);
          break;
        case "release_inputs":
          result = this.execReleaseInputs(String(command.params.device_id ?? ""));
          break;
        case "cancel_and_release":
          result = this.execCancelAndRelease(String(command.params.device_id ?? ""));
          break;
        case "clipboard_get":
          result = await this.execClipboardGet(command.params);
          break;
        case "clipboard_set":
          result = await this.execClipboardSet(command.params);
          break;
        case "select_display":
          result = await this.execSelectDisplay(command.params);
          break;
        case "disconnect":
          result = await this.execDisconnect(String(command.params.device_id ?? ""));
          break;
        default:
          throw new BridgeCommandError("NOT_FOUND", `浏览器桥接不支持命令：${command.method}`);
      }
      await this.postReply(command.request_id, true, result);
    } catch (caught) {
      const err =
        caught instanceof BridgeCommandError
          ? {
              code: caught.code,
              message: caught.message,
              retryable: caught.retryable,
              side_effect_possible: caught.sideEffectPossible,
            }
          : {
              code: "BROWSER_COMMAND_FAILED",
              message: caught instanceof Error ? caught.message : String(caught),
              retryable: false,
              side_effect_possible: false,
            };
      await this.postReply(command.request_id, false, err);
    }
  }

  private normalizeRegion(video: HTMLVideoElement, requested?: RegionRect): RegionRect {
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!requested) return { x: 0, y: 0, width: srcW, height: srcH };
    if (requested.x >= srcW || requested.y >= srcH) {
      throw new BridgeCommandError("INVALID_ARGUMENT", `裁剪区域起点 (${requested.x}, ${requested.y}) 超出源分辨率 ${srcW}×${srcH}。`);
    }
    const width = Math.min(requested.width, srcW - requested.x);
    const height = Math.min(requested.height, srcH - requested.y);
    if (width <= 0 || height <= 0) {
      throw new BridgeCommandError("INVALID_ARGUMENT", "裁剪区域尺寸无效。");
    }
    return { x: requested.x, y: requested.y, width, height };
  }

  private sampleRegionFingerprint(video: HTMLVideoElement, region: RegionRect): FrameFingerprint {
    const w = Math.min(SAMPLE_WIDTH, Math.max(16, region.width));
    const h = Math.min(SAMPLE_HEIGHT, Math.max(16, region.height));
    const canvas = this.sampleCanvas ?? (this.sampleCanvas = document.createElement("canvas"));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new BridgeCommandError("INTERNAL_ERROR", "浏览器不支持 Canvas 2D 采样。");
    ctx.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return {
      width: w,
      height: h,
      region,
      pixels: new Uint8Array(img.data.buffer.slice(0)),
      capturedAt: Date.now(),
    };
  }

  private storeSnapshot(fp: FrameFingerprint): string {
    const id = `snap_${++this.snapshotSeq}`;
    this.snapshots.set(id, fp);
    while (this.snapshots.size > MAX_SNAPSHOT_CACHE) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest) this.snapshots.delete(oldest);
      else break;
    }
    return id;
  }

  private capturePng(video: HTMLVideoElement, displayIndex: number, regionInput?: RegionRect, maxEdge = 1280) {
    const region = this.normalizeRegion(video, regionInput);
    const longest = Math.max(region.width, region.height);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const outW = Math.max(1, Math.round(region.width * scale));
    const outH = Math.max(1, Math.round(region.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new BridgeCommandError("INTERNAL_ERROR", "无法创建 Canvas 2D 上下文。");
    ctx.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, outW, outH);
    const dataUrl = canvas.toDataURL("image/png");
    const prefix = "data:image/png;base64,";
    if (!dataUrl.startsWith(prefix)) {
      throw new BridgeCommandError("INTERNAL_ERROR", "PNG 编码失败。");
    }

    const fp = this.sampleRegionFingerprint(video, region);
    const snapshot_id = this.storeSnapshot(fp);

    return {
      display_index: displayIndex,
      source_size: { width: video.videoWidth, height: video.videoHeight },
      image_size: { width: outW, height: outH },
      region,
      frame_id: this.getFrameId(video),
      snapshot_id,
      png_base64: dataUrl.slice(prefix.length),
    };
  }

  private async execScreenshot(params: Record<string, unknown>) {
    const deviceId = String(params.device_id ?? "");
    const displayIndex = this.displayIndexByDevice.get(deviceId) ?? 0;
    const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 2000;
    const afterFrameId = typeof params.after_frame_id === "number" ? params.after_frame_id : undefined;
    const maxEdge = typeof params.max_edge === "number" ? params.max_edge : 1280;
    const region = params.region as RegionRect | undefined;

    const video = await this.ensureVideoReady(deviceId, displayIndex, timeoutMs);
    if (afterFrameId !== undefined) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && this.getFrameId(video) <= afterFrameId) {
        await sleep(40);
      }
    }
    return this.capturePng(video, displayIndex, region, maxEdge);
  }

  private async waitVisualCondition(
    video: HTMLVideoElement,
    region: RegionRect,
    condition: "changed" | "stable" | "frame",
    baseline: FrameFingerprint | null,
    stableMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ matched: boolean; elapsed_ms: number }> {
    const startedAt = Date.now();
    if (condition === "frame") {
      const startFrame = this.getFrameId(video);
      const deadline = startedAt + Math.max(0, timeoutMs);
      while (Date.now() < deadline) {
        if (signal?.aborted) break;
        if (this.getFrameId(video) > startFrame) {
          return { matched: true, elapsed_ms: Date.now() - startedAt };
        }
        await sleep(50);
      }
      return { matched: this.getFrameId(video) > startFrame, elapsed_ms: Date.now() - startedAt };
    }

    const base = baseline ?? this.sampleRegionFingerprint(video, region);
    const deadline = startedAt + Math.max(0, timeoutMs);

    if (condition === "changed") {
      while (Date.now() <= deadline) {
        if (signal?.aborted) return { matched: false, elapsed_ms: Date.now() - startedAt };
        const current = this.sampleRegionFingerprint(video, region);
        if (framesSignificantlyDifferent(base, current)) {
          return { matched: true, elapsed_ms: Date.now() - startedAt };
        }
        if (Date.now() >= deadline) break;
        await sleep(75);
      }
      return { matched: false, elapsed_ms: Date.now() - startedAt };
    }

    // condition === "stable"
    let prev = base;
    let stableSince = Date.now();
    while (Date.now() <= deadline) {
      if (signal?.aborted) return { matched: false, elapsed_ms: Date.now() - startedAt };
      await sleep(80);
      const current = this.sampleRegionFingerprint(video, region);
      if (framesNearlyIdentical(prev, current)) {
        if (Date.now() - stableSince >= stableMs) {
          return { matched: true, elapsed_ms: Date.now() - startedAt };
        }
      } else {
        prev = current;
        stableSince = Date.now();
      }
    }
    return { matched: false, elapsed_ms: Date.now() - startedAt };
  }

  private async execWait(params: Record<string, unknown>) {
    const deviceId = String(params.device_id ?? "");
    const displayIndex = this.displayIndexByDevice.get(deviceId) ?? 0;
    const condition = (params.condition === "stable" ? "stable" : "changed") as "changed" | "stable";
    const stableMs = typeof params.stable_ms === "number" ? params.stable_ms : 500;
    const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 5000;
    const maxEdge = typeof params.max_edge === "number" ? params.max_edge : 1280;
    const baselineId = typeof params.baseline_snapshot_id === "string" ? params.baseline_snapshot_id : null;

    const video = await this.ensureVideoReady(deviceId, displayIndex, 2000);
    const region = this.normalizeRegion(video, params.region as RegionRect | undefined);
    const baseline = baselineId ? (this.snapshots.get(baselineId) ?? null) : null;
    const waitResult = await this.waitVisualCondition(video, region, condition, baseline, stableMs, timeoutMs);
    const screenshot = this.capturePng(video, displayIndex, region, maxEdge);
    return { ...waitResult, screenshot };
  }

  private getHeldKeys(deviceId: string): Set<number> {
    let set = this.heldKeysByDevice.get(deviceId);
    if (!set) {
      set = new Set<number>();
      this.heldKeysByDevice.set(deviceId, set);
    }
    return set;
  }

  private getHeldButtons(deviceId: string): Set<StreamerMouseButtonKind> {
    let set = this.heldButtonsByDevice.get(deviceId);
    if (!set) {
      set = new Set<StreamerMouseButtonKind>();
      this.heldButtonsByDevice.set(deviceId, set);
    }
    return set;
  }

  private hasHeldInputs(deviceId: string): boolean {
    return this.getHeldKeys(deviceId).size > 0 || this.getHeldButtons(deviceId).size > 0;
  }

  private execReleaseInputs(deviceId: string) {
    const session = getRemoteSession(deviceId);
    this.getHeldKeys(deviceId).clear();
    this.getHeldButtons(deviceId).clear();
    try {
      session?.releaseAllInputs();
    } catch {
      // Best-effort release.
    }
    return { released: true, has_held_inputs: false };
  }

  private execCancelAndRelease(deviceId: string) {
    const controller = this.activeAbortByDevice.get(deviceId);
    if (controller) {
      controller.abort();
      this.activeAbortByDevice.delete(deviceId);
    }
    return this.execReleaseInputs(deviceId);
  }

  private async runSingleAction(
    deviceId: string,
    session: BrowserRemoteSession,
    action: SingleActionPlan,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new BridgeCommandError("HUMAN_PAUSED", "操作已被用户暂停或取消。", false, false);
    }
    const heldKeys = this.getHeldKeys(deviceId);
    const heldButtons = this.getHeldButtons(deviceId);
    const desktopScroll = isDesktopRemoteScrollTarget(this.resolveTargetPlatform(deviceId));

    const pressModifiers = (modifiers?: KeySpec[]) => {
      if (!modifiers?.length) return [];
      const newlyPressed: number[] = [];
      for (const mod of modifiers) {
        if (!heldKeys.has(mod.code)) {
          session.sendKeyboardInput({ action: "keyboardPress", value: mod.code });
          newlyPressed.push(mod.code);
        }
      }
      return newlyPressed;
    };

    const releaseModifiers = (codes: number[]) => {
      for (const code of [...codes].reverse()) {
        try {
          session.sendKeyboardInput({ action: "keyboardRelease", value: code });
        } catch {
          // Best-effort modifier cleanup.
        }
      }
    };

    switch (action.type) {
      case "move": {
        const mods = pressModifiers(action.modifiers);
        try {
          session.sendMouseMove(
            { absX: action.absX, absY: action.absY, surfaceWidth: action.surfaceWidth, surfaceHeight: action.surfaceHeight },
            { critical: true },
          );
        } finally {
          releaseModifiers(mods);
        }
        return;
      }
      case "mouse_down": {
        session.sendMouseMove(
          { absX: action.absX, absY: action.absY, surfaceWidth: action.surfaceWidth, surfaceHeight: action.surfaceHeight },
          { critical: true },
        );
        session.sendMouseButton({ action: "mousePress", button: action.uuButton });
        heldButtons.add(action.uuButton);
        return;
      }
      case "mouse_up": {
        session.sendMouseMove(
          { absX: action.absX, absY: action.absY, surfaceWidth: action.surfaceWidth, surfaceHeight: action.surfaceHeight },
          { critical: true },
        );
        session.sendMouseButton({ action: "mouseRelease", button: action.uuButton });
        heldButtons.delete(action.uuButton);
        return;
      }
      case "click": {
        const mods = pressModifiers(action.modifiers);
        try {
          session.sendMouseMove(
            { absX: action.absX, absY: action.absY, surfaceWidth: action.surfaceWidth, surfaceHeight: action.surfaceHeight },
            { critical: true },
          );
          session.sendMouseButton({ action: "mousePress", button: action.uuButton });
          await sleepAbortable(25, signal);
          session.sendMouseButton({ action: "mouseRelease", button: action.uuButton });
        } finally {
          releaseModifiers(mods);
        }
        return;
      }
      case "double_click": {
        const mods = pressModifiers(action.modifiers);
        try {
          session.sendMouseMove(
            { absX: action.absX, absY: action.absY, surfaceWidth: action.surfaceWidth, surfaceHeight: action.surfaceHeight },
            { critical: true },
          );
          session.sendMouseButton({ action: "mousePress", button: action.uuButton });
          await sleepAbortable(20, signal);
          session.sendMouseButton({ action: "mouseRelease", button: action.uuButton });
          await sleepAbortable(65, signal);
          session.sendMouseButton({ action: "mousePress", button: action.uuButton });
          await sleepAbortable(20, signal);
          session.sendMouseButton({ action: "mouseRelease", button: action.uuButton });
        } finally {
          releaseModifiers(mods);
        }
        return;
      }
      case "scroll": {
        const mods = pressModifiers(action.modifiers);
        try {
          session.sendMouseMove(
            { absX: action.absX, absY: action.absY, surfaceWidth: action.surfaceWidth, surfaceHeight: action.surfaceHeight },
            { critical: true },
          );
          const magnitude = action.ticks * SCROLL_STEP_PER_TICK;
          const deltaX = action.direction === "left" ? -magnitude : action.direction === "right" ? magnitude : 0;
          const rawY = action.direction === "down" ? magnitude : action.direction === "up" ? -magnitude : 0;
          const deltaY = desktopScroll ? -rawY : rawY;
          session.sendMouseScroll({ deltaX, deltaY });
        } finally {
          releaseModifiers(mods);
        }
        return;
      }
      case "drag": {
        const points = action.mappedPath;
        const first = points[0];
        if (!first) return;
        const mods = pressModifiers(action.modifiers);
        try {
          session.sendMouseMove(first, { critical: true });
          await sleepAbortable(20, signal);
          session.sendMouseButton({ action: "mousePress", button: action.uuButton });
          heldButtons.add(action.uuButton);

          const segments = points.length - 1;
          const totalSteps = Math.max(segments, Math.min(90, Math.round(action.duration_ms / 16)));
          const stepDelay = Math.max(8, Math.round(action.duration_ms / totalSteps));
          for (let step = 1; step <= totalSteps; step += 1) {
            await sleepAbortable(stepDelay, signal);
            const progress = (step / totalSteps) * segments;
            const segIdx = Math.min(segments - 1, Math.floor(progress));
            const t = progress - segIdx;
            const p0 = points[segIdx];
            const p1 = points[segIdx + 1];
            const isLast = step === totalSteps;
            session.sendMouseMove(
              {
                absX: p0.absX + (p1.absX - p0.absX) * t,
                absY: p0.absY + (p1.absY - p0.absY) * t,
                surfaceWidth: p1.surfaceWidth,
                surfaceHeight: p1.surfaceHeight,
              },
              { critical: isLast },
            );
          }
          await sleepAbortable(20, signal);
          session.sendMouseButton({ action: "mouseRelease", button: action.uuButton });
          heldButtons.delete(action.uuButton);
        } finally {
          if (heldButtons.has(action.uuButton)) {
            try {
              session.sendMouseButton({ action: "mouseRelease", button: action.uuButton });
            } catch {
              // Ignore cleanup error.
            }
            heldButtons.delete(action.uuButton);
          }
          releaseModifiers(mods);
        }
        return;
      }
      case "key_down": {
        session.sendKeyboardInput({ action: "keyboardPress", value: action.keyCode });
        heldKeys.add(action.keyCode);
        return;
      }
      case "key_up": {
        session.sendKeyboardInput({ action: "keyboardRelease", value: action.keyCode });
        heldKeys.delete(action.keyCode);
        return;
      }
      case "key_press": {
        const mods = pressModifiers(action.modifiers);
        try {
          session.sendKeyboardInput({ action: "keyboardPress", value: action.keyCode });
          await sleepAbortable(action.duration_ms, signal);
          session.sendKeyboardInput({ action: "keyboardRelease", value: action.keyCode });
        } finally {
          releaseModifiers(mods);
        }
        return;
      }
      case "hotkey": {
        const pressed: number[] = [];
        try {
          for (const item of action.keys) {
            if (!heldKeys.has(item.code)) {
              session.sendKeyboardInput({ action: "keyboardPress", value: item.code });
              pressed.push(item.code);
            }
          }
          await sleepAbortable(action.duration_ms, signal);
        } finally {
          for (const code of [...pressed].reverse()) {
            try {
              session.sendKeyboardInput({ action: "keyboardRelease", value: code });
            } catch {
              // Ignore cleanup error.
            }
          }
        }
        return;
      }
      case "type_text": {
        session.sendTextInput(action.text);
        return;
      }
    }
  }

  private async execAction(params: Record<string, unknown>) {
    const deviceId = String(params.device_id ?? "");
    const session = getRemoteSession(deviceId);
    if (!session) {
      throw new BridgeCommandError("SESSION_NOT_FOUND", "远端会话已不存在。", false, false);
    }
    const plan = params.plan as ActionPlan;
    const observeAfter = Boolean(params.observe_after);
    const waitSpec = (params.wait as ActionWaitSpec | null) ?? null;
    const displayIndex = this.displayIndexByDevice.get(deviceId) ?? 0;

    const controller = new AbortController();
    this.activeAbortByDevice.set(deviceId, controller);

    const startedAt = Date.now();
    let baseline: FrameFingerprint | null = null;
    let videoForWait: HTMLVideoElement | null = null;
    let waitRegion: RegionRect | null = null;

    if (observeAfter && waitSpec) {
      videoForWait = this.findVideoElement(deviceId, displayIndex);
      if (videoForWait && videoForWait.readyState >= 2 && videoForWait.videoWidth > 0) {
        waitRegion = this.normalizeRegion(videoForWait, waitSpec.region);
        baseline =
          (waitSpec.baseline_snapshot_id ? this.snapshots.get(waitSpec.baseline_snapshot_id) : null) ??
          this.sampleRegionFingerprint(videoForWait, waitRegion);
      }
    }

    let submittedAny = false;
    let sequenceMeta: { action_count: number; finished_actions: number; stopped_at?: number } | undefined;

    try {
      if (plan.type === "sequence") {
        sequenceMeta = { action_count: plan.actions.length, finished_actions: 0 };
        for (let i = 0; i < plan.actions.length; i += 1) {
          if (controller.signal.aborted) {
            sequenceMeta.stopped_at = i;
            throw new BridgeCommandError("HUMAN_PAUSED", "动作序列已被用户暂停或中断。", false, submittedAny);
          }
          submittedAny = true;
          await this.runSingleAction(deviceId, session, plan.actions[i], controller.signal);
          sequenceMeta.finished_actions = i + 1;
          if (i < plan.actions.length - 1 && plan.interval_ms > 0) {
            await sleepAbortable(plan.interval_ms, controller.signal);
          }
        }
      } else {
        submittedAny = true;
        await this.runSingleAction(deviceId, session, plan, controller.signal);
      }

      const inputDurationMs = Date.now() - startedAt;
      let waitResult: { matched: boolean; elapsed_ms: number } | undefined;
      let screenshot: ReturnType<LocalAgentBridgeRuntime["capturePng"]> | undefined;

      if (observeAfter && !controller.signal.aborted) {
        try {
          const video = videoForWait ?? (await this.ensureVideoReady(deviceId, displayIndex, 1000));
          const region = waitRegion ?? this.normalizeRegion(video, waitSpec?.region);
          if (waitSpec) {
            waitResult = await this.waitVisualCondition(
              video,
              region,
              waitSpec.condition,
              baseline,
              waitSpec.stable_ms ?? 200,
              waitSpec.timeout_ms ?? 1000,
              controller.signal,
            );
          }
          screenshot = this.capturePng(video, displayIndex, undefined, waitSpec?.max_edge ?? 1280);
        } catch {
          // Input already submitted; preserve input result even if post-capture fails.
        }
      }

      return {
        status: "submitted",
        has_held_inputs: this.hasHeldInputs(deviceId),
        after_frame_id: screenshot?.frame_id ?? (videoForWait ? this.getFrameId(videoForWait) : 0),
        timing_ms: { input: inputDurationMs, total: Date.now() - startedAt },
        ...(sequenceMeta ? { sequence: sequenceMeta } : {}),
        ...(waitResult ? { wait_result: waitResult } : {}),
        ...(screenshot ? { screenshot } : {}),
      };
    } catch (caught) {
      if (submittedAny) {
        this.execReleaseInputs(deviceId);
      }
      if (caught instanceof BridgeCommandError) {
        throw new BridgeCommandError(caught.code, caught.message, caught.retryable, submittedAny || caught.sideEffectPossible);
      }
      throw new BridgeCommandError(
        "BROWSER_COMMAND_FAILED",
        caught instanceof Error ? caught.message : String(caught),
        false,
        submittedAny,
      );
    } finally {
      if (this.activeAbortByDevice.get(deviceId) === controller) {
        this.activeAbortByDevice.delete(deviceId);
      }
    }
  }

  private async execClipboardGet(params: Record<string, unknown>) {
    const deviceId = String(params.device_id ?? "");
    const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 4000;
    const session = getRemoteSession(deviceId);
    if (!session) throw new BridgeCommandError("SESSION_NOT_FOUND", "远端会话不存在。");

    const before = this.clipboardByDevice.get(deviceId);
    const waitPromise = new Promise<string | null>((resolve) => {
      let set = this.clipboardWaiters.get(deviceId);
      if (!set) {
        set = new Set();
        this.clipboardWaiters.set(deviceId, set);
      }
      const onText = (text: string) => {
        window.clearTimeout(timer);
        set?.delete(onText);
        resolve(text);
      };
      const timer = window.setTimeout(() => {
        set?.delete(onText);
        resolve(null);
      }, timeoutMs);
      set.add(onText);
    });

    try {
      session.requestRemoteClipboardText();
    } catch {
      // Fallback to most recently pushed clipboard value if active request is unsupported.
      if (before) return { text: before.text, source: "cached_notification" };
      throw new BridgeCommandError("CONTROL_DENIED", "远端剪贴板通道尚未就绪。");
    }

    const fresh = await waitPromise;
    if (fresh !== null) return { text: fresh, source: "remote" };
    if (before) return { text: before.text, source: "cached_notification" };
    throw new BridgeCommandError("TIMEOUT", "等待远端剪贴板返回超时（Windows 被控端可能仅在远端复制时主动推送剪贴板）。", true, false);
  }

  private async execClipboardSet(params: Record<string, unknown>) {
    const deviceId = String(params.device_id ?? "");
    const text = String(params.text ?? "");
    const session = getRemoteSession(deviceId);
    if (!session) throw new BridgeCommandError("SESSION_NOT_FOUND", "远端会话不存在。");
    await session.sendClipboardText(text);
    return { applied: true };
  }

  private async execSelectDisplay(params: Record<string, unknown>) {
    const deviceId = String(params.device_id ?? "");
    const displayIndex = Number(params.display_index ?? 0);
    const streams = getRemoteVideoStreams(deviceId);
    if (streams.length === 0) {
      throw new BridgeCommandError("DISPLAY_NOT_FOUND", "当前会话暂无可用视频源。");
    }
    if (!Number.isInteger(displayIndex) || displayIndex < 0 || displayIndex >= streams.length) {
      throw new BridgeCommandError("DISPLAY_NOT_FOUND", `无效的显示器索引 ${displayIndex}，可用范围 0–${streams.length - 1}。`);
    }
    this.displayIndexByDevice.set(deviceId, displayIndex);
    const video = await this.ensureVideoReady(deviceId, displayIndex, 2000).catch(() => null);
    await this.syncState(true);
    return {
      active_display_index: displayIndex,
      source_size: video ? { width: video.videoWidth, height: video.videoHeight } : { width: 0, height: 0 },
    };
  }

  private async execDisconnect(deviceId: string) {
    this.execCancelAndRelease(deviceId);
    for (const [key, video] of [...this.offscreenVideos.entries()]) {
      if (key.startsWith(`${deviceId}::`)) {
        video.srcObject = null;
        video.remove();
        this.offscreenVideos.delete(key);
      }
    }
    await teardownRemoteConnection(deviceId);
    await this.syncState(true);
    return { disconnected: true };
  }

  private async sendViewerControl(sessionId: string, operation: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      const response = await fetch("/__uubridge/agent/viewer-control", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, operation, ...extra }),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { session?: BrokerPolicy };
      if (payload.session) {
        this.policies.set(payload.session.session_id, payload.session);
        this.renderBar();
      }
    } catch {
      // Ignore network hiccup.
    }
  }

  private installHumanTakeoverListener(): void {
    const onHumanInput = (event: Event) => {
      if (!event.isTrusted) return;
      if (event instanceof KeyboardEvent) {
        // Ignore bare modifier keys and OS window-switching chords (e.g. Cmd+Tab / Cmd+H)
        // so switching back to the Agent chat window does not accidentally pause Agent control.
        if (["Meta", "Control", "Alt", "Shift", "AltGraph"].includes(event.key)) return;
        if (event.metaKey && ["Tab", "h", "H", "`"].includes(event.key)) return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (this.uiHost && (target === this.uiHost || this.uiHost.contains(target))) return;
      if (!target.closest(".remote-stage")) return;

      const active = this.selectDisplayedPolicy();
      if (!active || !active.authorized || active.human_paused || !active.auto_pause_on_human_input) return;
      this.execCancelAndRelease(active.device_id);
      active.human_paused = true;
      active.control_allowed = false;
      this.renderBar();
      void this.sendViewerControl(active.session_id, "pause", { reason: "human_input_takeover" });
    };

    window.addEventListener("pointerdown", onHumanInput, true);
    window.addEventListener("keydown", onHumanInput, true);
  }

  private selectDisplayedPolicy(): BrokerPolicy | null {
    const match = window.location.pathname.match(/\/remote\/([^/]+)/);
    const routeDeviceId = match ? decodeURIComponent(match[1]) : "";
    if (routeDeviceId) {
      const exact = this.policies.get(`uu:${routeDeviceId}`);
      if (exact) return exact;
    }
    return this.policies.values().next().value ?? null;
  }

  private initTheme(): void {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark" || saved === "system") {
        this.themeMode = saved;
      }
    } catch {
      this.themeMode = "system";
    }
    this.colorSchemeMedia = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    this.onColorSchemeChange = () => {
      if (this.themeMode === "system") {
        this.applyDocumentTheme();
        this.renderBar();
      }
    };
    this.colorSchemeMedia?.addEventListener?.("change", this.onColorSchemeChange);
    this.applyDocumentTheme();
  }

  private getResolvedTheme(): "light" | "dark" {
    if (this.themeMode === "light" || this.themeMode === "dark") return this.themeMode;
    return this.colorSchemeMedia?.matches ? "dark" : "light";
  }

  private setThemeMode(mode: ThemeMode): void {
    this.themeMode = mode;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures.
    }
    this.applyDocumentTheme();
    this.renderBar();
  }

  private applyDocumentTheme(): void {
    const resolved = this.getResolvedTheme();
    document.documentElement.dataset.uubridgeTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
    let styleEl = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = THEME_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = resolved === "dark" ? PAGE_DARK_THEME_CSS : PAGE_LIGHT_THEME_CSS;
  }

  private mountControlBar(): void {
    const host = document.createElement("div");
    host.id = "uubridge-agent-bar";
    this.uiHost = host;
    this.uiRoot = host.attachShadow({ mode: "open" });
    this.syncMountPoint();
    this.renderBar();
  }

  private observeSidebarMount(): void {
    if (typeof MutationObserver === "undefined") return;
    const scheduleSync = () => {
      // Fast short-circuit: already docked inside a connected sidebar panel.
      if (
        this.dockedInSidebar &&
        this.uiHost?.parentElement?.isConnected &&
        this.uiHost.parentElement.classList.contains("control-side-panel")
      ) {
        return;
      }
      if (this.mountCheckRaf !== null) return;
      this.mountCheckRaf = window.requestAnimationFrame(() => {
        this.mountCheckRaf = null;
        if (this.syncMountPoint()) this.renderBar(true);
      });
    };
    this.domObserver = new MutationObserver(scheduleSync);
    this.domObserver.observe(document.body, { childList: true, subtree: true });
  }

  private syncMountPoint(): boolean {
    const host = this.uiHost;
    if (!host) return false;
    const sidePanel = document.querySelector<HTMLElement>(".control-side-panel");
    const shouldDock = Boolean(sidePanel && sidePanel.isConnected);
    const prevDocked = this.dockedInSidebar;

    if (shouldDock && sidePanel) {
      this.dockedInSidebar = true;
      host.dataset.docked = "sidebar";
      host.style.position = "static";
      host.style.flex = "0 0 auto";
      host.style.width = "100%";
      host.style.left = "auto";
      host.style.top = "auto";
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.zIndex = "auto";
      if (host.parentElement !== sidePanel) {
        sidePanel.appendChild(host);
      }
      return prevDocked !== true;
    }

    this.dockedInSidebar = false;
    host.dataset.docked = "floating";
    host.style.position = "fixed";
    host.style.flex = "";
    host.style.width = "auto";
    host.style.zIndex = "2147483000";
    if (this.barPosition) {
      host.style.left = `${this.barPosition.left}px`;
      host.style.top = `${this.barPosition.top}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    } else {
      host.style.left = "auto";
      host.style.top = "auto";
      host.style.right = "14px";
      host.style.bottom = "14px";
    }
    if (host.parentElement !== document.body) {
      document.body.appendChild(host);
    }
    // When side panel was just closed, auto-collapse to compact corner pill so it won't block video.
    if (prevDocked && !this.dockedInSidebar) {
      this.uiCollapsed = true;
    }
    return prevDocked !== false;
  }

  private bindThemeButtons(root: ShadowRoot): void {
    for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-theme-mode]")) {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.themeMode;
        if (mode === "system" || mode === "light" || mode === "dark") {
          this.setThemeMode(mode);
        }
      });
    }
  }

  private bindDragHandle(handle: HTMLElement | null): void {
    const host = this.uiHost;
    if (!handle || !host) return;
    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, input, label")) return;
      const rect = host.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const onMove = (moveEvent: PointerEvent) => {
        const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
        const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
        const left = Math.min(maxLeft, Math.max(8, moveEvent.clientX - offsetX));
        const top = Math.min(maxTop, Math.max(8, moveEvent.clientY - offsetY));
        this.barPosition = { left, top };
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
        host.style.right = "auto";
        host.style.bottom = "auto";
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  private themeSwitcherHtml(): string {
    const choices: Array<[ThemeMode, string, string]> = [
      ["system", "自动", "跟随系统外观"],
      ["light", "浅", "浅色模式"],
      ["dark", "深", "深色模式"],
    ];
    return `<div class="theme-seg" role="group" aria-label="主题切换">${choices
      .map(
        ([mode, label, title]) =>
          `<button type="button" class="tbtn${this.themeMode === mode ? " active" : ""}" data-theme-mode="${mode}" title="${title}" aria-pressed="${String(this.themeMode === mode)}">${label}</button>`,
      )
      .join("")}</div>`;
  }

  private renderBar(force = false): void {
    this.syncMountPoint();
    const root = this.uiRoot;
    if (!root) return;
    const policy = this.selectDisplayedPolicy();
    const isDark = this.getResolvedTheme() === "dark";
    const docked = this.dockedInSidebar;
    const renderKey = JSON.stringify({
      docked,
      collapsed: this.uiCollapsed,
      isDark,
      themeMode: this.themeMode,
      sseConnected: this.sseConnected,
      policy,
    });
    if (!force && renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    const palette = isDark
      ? {
          bg: docked ? "#131316" : "rgba(20, 24, 33, 0.92)",
          border: docked ? "rgba(255, 255, 255, 0.09)" : "rgba(148, 163, 184, 0.26)",
          text: "#f1f5f9",
          soft: "#cbd5e1",
          muted: "#94a3b8",
          segBg: "rgba(255, 255, 255, 0.06)",
          segActiveBg: "rgba(255, 255, 255, 0.16)",
          btnBg: "rgba(255, 255, 255, 0.06)",
          btnHover: "rgba(255, 255, 255, 0.12)",
          divider: "rgba(255, 255, 255, 0.08)",
          shadow: docked ? "none" : "0 12px 32px rgba(0, 0, 0, 0.44)",
          dangerBg: "rgba(127, 29, 29, 0.45)",
          dangerBorder: "rgba(248, 113, 113, 0.35)",
          dangerText: "#fecaca",
        }
      : {
          bg: docked ? "#ffffff" : "rgba(255, 255, 255, 0.94)",
          border: docked ? "#dde3ec" : "rgba(15, 23, 42, 0.12)",
          text: "#0f172a",
          soft: "#334155",
          muted: "#64748b",
          segBg: "#f1f5f9",
          segActiveBg: "#ffffff",
          btnBg: "#f8fafc",
          btnHover: "#eef2f6",
          divider: "#e2e8f0",
          shadow: docked ? "none" : "0 10px 30px rgba(15, 23, 42, 0.12)",
          dangerBg: "#fef2f2",
          dangerBorder: "#fecaca",
          dangerText: "#b91c1c",
        };

    const sharedStyles = `
      * { box-sizing: border-box; }
      .theme-seg { display: inline-flex; align-items: center; gap: 1px; padding: 2px; border-radius: 999px;
        background: ${palette.segBg}; border: 1px solid ${palette.border}; }
      .tbtn { border: none; background: transparent; color: ${palette.muted}; font: 500 10.5px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        padding: 3px 6px; border-radius: 999px; cursor: pointer; }
      .tbtn:hover { color: ${palette.text}; }
      .tbtn.active { background: ${palette.segActiveBg}; color: ${palette.text}; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
    `;

    if (!policy) {
      root.innerHTML = `
        <style>
          ${sharedStyles}
          .pill { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; color: ${palette.soft};
            background: ${palette.bg}; ${docked ? `border-top: 1px solid ${palette.border}; padding: 10px 12px; width: 100%; justify-content: space-between;` : `border: 1px solid ${palette.border}; border-radius: 999px; padding: 6px 8px 6px 12px; backdrop-filter: blur(12px); box-shadow: ${palette.shadow};`}
            display: inline-flex; align-items: center; gap: 8px; user-select: none; }
          .left { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
          .dot { width: 7px; height: 7px; border-radius: 50%; background: ${this.sseConnected ? "#10b981" : "#94a3b8"}; flex-shrink: 0; }
        </style>
        <div class="pill" role="status" aria-live="polite">
          <span class="left"><span class="dot"></span><span>${this.sseConnected ? (docked ? "Agent 桥接就绪" : "Agent 就绪 · 连接设备后可授权控制") : "Agent 桥接重连中…"}</span></span>
          ${this.themeSwitcherHtml()}
        </div>
      `;
      this.bindThemeButtons(root);
      return;
    }

    const deviceName = listConnections().find((c) => c.deviceId === policy.device_id)?.deviceName || policy.device_id;
    const statusColor = policy.human_paused
      ? "#f59e0b"
      : policy.busy
        ? "#22c55e"
        : policy.control_allowed
          ? "#10b981"
          : "#3b82f6";
    const statusLabel = policy.human_paused
      ? "人类已暂停"
      : policy.busy
        ? "Agent 执行中"
        : policy.control_allowed
          ? "Agent 已授权"
          : "Agent 仅观察";
    const guideText = policy.human_paused
      ? "已暂停 Agent，你可以自由操作画面。"
      : policy.control_allowed
        ? "Agent 可操控远端；随时点「暂停」接管。"
        : "默认仅截屏观察，点下方授权才放行输入。";

    if (this.uiCollapsed && !docked) {
      root.innerHTML = `
        <style>
          ${sharedStyles}
          .pill { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; color: ${palette.text};
            background: ${palette.bg}; border: 1px solid ${palette.border}; border-radius: 999px;
            padding: 4px 7px 4px 10px; display: inline-flex; align-items: center; gap: 7px;
            backdrop-filter: blur(12px); box-shadow: ${palette.shadow}; user-select: none; }
          .expand { border: none; background: transparent; color: inherit; font: 600 11.5px/1.3 inherit;
            display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 2px 3px; }
          .dot { width: 7px; height: 7px; border-radius: 50%; background: ${statusColor}; }
          .quick { border: 1px solid ${palette.border}; background: ${palette.btnBg}; color: ${palette.text};
            font: 500 11px/1.2 inherit; padding: 3px 8px; border-radius: 999px; cursor: pointer; }
          .quick:hover { background: ${palette.btnHover}; }
        </style>
        <div class="pill">
          <button id="expand" class="expand" type="button" title="展开 Agent 控制条">
            <span class="dot"></span><span id="collapsed-label"></span>
          </button>
          ${policy.authorized ? `<button id="quick-pause" class="quick" type="button">${policy.human_paused ? "恢复" : "暂停"}</button>` : ""}
          ${this.themeSwitcherHtml()}
        </div>
      `;
      const lbl = root.getElementById("collapsed-label");
      if (lbl) lbl.textContent = statusLabel;
      this.bindThemeButtons(root);
      root.getElementById("expand")?.addEventListener("click", () => {
        this.uiCollapsed = false;
        this.renderBar();
      });
      root.getElementById("quick-pause")?.addEventListener("click", () => {
        if (!policy.human_paused) this.execCancelAndRelease(policy.device_id);
        void this.sendViewerControl(policy.session_id, policy.human_paused ? "resume" : "pause");
      });
      return;
    }

    const lastActionText = policy.last_action
      ? `最近：${new Date(policy.last_action.at).toLocaleTimeString([], { hour12: false })} · ${policy.last_action.summary}`
      : "尚未收到 Agent 输入指令";

    root.innerHTML = `
      <style>
        ${sharedStyles}
        .card { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; color: ${palette.text};
          background: ${palette.bg};
          ${
            docked
              ? `border-top: 1px solid ${palette.border}; padding: 10px 12px 11px; width: 100%;`
              : `border: 1px solid ${palette.border}; border-radius: 14px; padding: 11px 13px; width: 312px; backdrop-filter: blur(14px); box-shadow: ${palette.shadow};`
          }
          user-select: none; }
        .header { display: flex; align-items: center; justify-content: space-between; gap: 6px; ${docked ? "" : "cursor: grab;"} }
        ${docked ? "" : ".header:active { cursor: grabbing; }"}
        .title-wrap { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
        .title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; color: ${palette.text}; }
        .device { font-size: 10.5px; color: ${palette.muted}; padding-left: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .header-right { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: ${statusColor}; flex-shrink: 0; }
        .icon-btn { background: transparent; border: none; color: ${palette.muted}; cursor: pointer; padding: 2px 5px; border-radius: 6px; font-size: 12px; }
        .icon-btn:hover { background: ${palette.btnHover}; color: ${palette.text}; }
        .guide { margin: 6px 0 0; font-size: 11px; color: ${palette.muted}; line-height: 1.45; }
        .actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; margin-top: 8px; }
        .btn { padding: 6px 6px; border-radius: 8px; border: 1px solid ${palette.border};
          background: ${palette.btnBg}; color: ${palette.text}; font-size: 11.5px; font-weight: 550; cursor: pointer;
          transition: background .12s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .btn:hover:not(:disabled) { background: ${palette.btnHover}; }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn.primary { background: #15803d; border-color: #16a34a; color: #ffffff; }
        .btn.primary:hover:not(:disabled) { background: #166534; }
        .btn.warn { background: #d97706; border-color: #f59e0b; color: #ffffff; }
        .btn.warn:hover:not(:disabled) { background: #b45309; }
        .btn.danger { background: ${palette.dangerBg}; border-color: ${palette.dangerBorder}; color: ${palette.dangerText}; }
        .meta { margin-top: 8px; padding-top: 7px; border-top: 1px solid ${palette.divider};
          display: flex; flex-direction: column; gap: 5px; color: ${palette.muted}; font-size: 11px; }
        label.opt { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: ${palette.soft}; }
        .log { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: ${palette.muted}; }
      </style>
      <div class="card" role="region" aria-label="Agent 协同控制条">
        <div id="drag-handle" class="header" title="${docked ? "Agent 协同控制" : "按住此处可拖动控制条位置"}">
          <div class="title-wrap">
            <span class="title"><span class="dot"></span><span id="status-text"></span></span>
            ${docked ? "" : '<span id="device-name" class="device"></span>'}
          </div>
          <div class="header-right">
            ${this.themeSwitcherHtml()}
            ${docked ? "" : '<button id="collapse" class="icon-btn" type="button" title="收起为胶囊">▾</button>'}
          </div>
        </div>
        <p id="guide-text" class="guide"></p>
        <div class="actions">
          <button id="toggle-auth" class="btn ${policy.authorized ? "" : "primary"}" type="button">
            ${policy.authorized ? "撤销授权" : "允许控制"}
          </button>
          <button id="toggle-pause" class="btn ${policy.human_paused ? "primary" : "warn"}" type="button" ${policy.authorized ? "" : "disabled"}>
            ${policy.human_paused ? "恢复控制" : "暂停接管"}
          </button>
          <button id="release" class="btn danger" type="button">释放按键</button>
        </div>
        <div class="meta">
          <label class="opt">
            <input id="auto-pause" type="checkbox" ${policy.auto_pause_on_human_input ? "checked" : ""} />
            <span>操作画面时自动暂停</span>
          </label>
          <div id="last-action" class="log"></div>
        </div>
      </div>
    `;

    const statusEl = root.getElementById("status-text");
    if (statusEl) statusEl.textContent = statusLabel;
    const devEl = root.getElementById("device-name");
    if (devEl) devEl.textContent = `当前设备：${deviceName}`;
    const guideEl = root.getElementById("guide-text");
    if (guideEl) guideEl.textContent = guideText;
    const logEl = root.getElementById("last-action");
    if (logEl) logEl.textContent = lastActionText;

    this.bindThemeButtons(root);
    if (!docked) {
      this.bindDragHandle(root.getElementById("drag-handle"));
    }

    root.getElementById("collapse")?.addEventListener("click", () => {
      this.uiCollapsed = true;
      this.renderBar();
    });
    root.getElementById("toggle-auth")?.addEventListener("click", () => {
      if (policy.authorized) this.execCancelAndRelease(policy.device_id);
      void this.sendViewerControl(policy.session_id, policy.authorized ? "revoke" : "authorize");
    });
    root.getElementById("toggle-pause")?.addEventListener("click", () => {
      if (!policy.human_paused) this.execCancelAndRelease(policy.device_id);
      void this.sendViewerControl(policy.session_id, policy.human_paused ? "resume" : "pause");
    });
    root.getElementById("release")?.addEventListener("click", () => {
      this.execCancelAndRelease(policy.device_id);
      void this.sendViewerControl(policy.session_id, "release_inputs");
    });
    root.getElementById("auto-pause")?.addEventListener("change", (event) => {
      const checked = (event.target as HTMLInputElement).checked;
      void this.sendViewerControl(policy.session_id, "set_auto_pause", { enabled: checked });
    });
  }
}

function framesSignificantlyDifferent(a: FrameFingerprint, b: FrameFingerprint): boolean {
  if (a.width !== b.width || a.height !== b.height || a.pixels.length !== b.pixels.length) return true;
  const totalPixels = a.width * a.height;
  if (totalPixels === 0) return false;
  let totalDiff = 0;
  let changedPixels = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    const d =
      Math.abs(a.pixels[i] - b.pixels[i]) +
      Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
      Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
    totalDiff += d / 3;
    if (d > 36) changedPixels += 1;
  }
  const mad = totalDiff / totalPixels;
  const changedRatio = changedPixels / totalPixels;
  return mad >= 2.2 || changedRatio >= 0.004;
}

function framesNearlyIdentical(a: FrameFingerprint, b: FrameFingerprint): boolean {
  if (a.width !== b.width || a.height !== b.height || a.pixels.length !== b.pixels.length) return false;
  const totalPixels = a.width * a.height;
  if (totalPixels === 0) return true;
  let totalDiff = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    totalDiff +=
      (Math.abs(a.pixels[i] - b.pixels[i]) +
        Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
        Math.abs(a.pixels[i + 2] - b.pixels[i + 2])) /
      3;
  }
  return totalDiff / totalPixels < 1.0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) {
    return Promise.reject(new BridgeCommandError("HUMAN_PAUSED", "操作已被暂停或取消。", false, true));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new BridgeCommandError("HUMAN_PAUSED", "操作已被暂停或取消。", false, true));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
