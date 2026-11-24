import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserRemoteSession } from "../src/remote/browserRemoteSession.js";
import { openConnection, resetConnections } from "../src/remote/remoteConnectionsStore.js";
import { makeSessionEventBridge, resetRemoteSessionEventBridge } from "../src/remote/remoteSessionEventBridge.js";
import {
  attachRemoteSession,
  publishRemoteSessionState,
  resetRemoteSessionStore,
} from "../src/remote/remoteSessionStore.js";
import { resetRemoteVideoStreamsStore } from "../src/remote/remoteVideoStreamsStore.js";
import { LocalAgentBridgeRuntime, resetLocalAgentBridgeForTest, startLocalAgentBridge } from "../src/localAgentBridge.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

describe("localAgentBridge", () => {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    FakeEventSource.instances = [];
    resetLocalAgentBridgeForTest();
    resetConnections();
    resetRemoteSessionStore();
    resetRemoteVideoStreamsStore();
    resetRemoteSessionEventBridge();
    document.body.innerHTML = "";
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("stays dormant when local agent capabilities endpoint is absent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await startLocalAgentBridge();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(document.getElementById("uubridge-agent-bar")).toBeNull();
  });

  it("dispatches UU protocol mouse/keyboard/scroll/text/clipboard commands and pauses on human takeover", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const session = {
      getTargetPlatform: () => 4, // macOS desktop
      sendMouseMove: vi.fn((...args) => calls.push({ method: "sendMouseMove", args })),
      sendMouseButton: vi.fn((...args) => calls.push({ method: "sendMouseButton", args })),
      sendMouseScroll: vi.fn((...args) => calls.push({ method: "sendMouseScroll", args })),
      sendKeyboardInput: vi.fn((...args) => calls.push({ method: "sendKeyboardInput", args })),
      sendTextInput: vi.fn((...args) => calls.push({ method: "sendTextInput", args })),
      releaseAllInputs: vi.fn(() => calls.push({ method: "releaseAllInputs", args: [] })),
      sendClipboardText: vi.fn(async (text: string) => {
        calls.push({ method: "sendClipboardText", args: [text] });
      }),
      requestRemoteClipboardText: vi.fn(() => {
        calls.push({ method: "requestRemoteClipboardText", args: [] });
        queueMicrotask(() => bridgeEvents.onRemoteClipboard("remote-copied-text"));
      }),
    } as unknown as BrowserRemoteSession;

    const bridgeEvents = makeSessionEventBridge("dev-mac");
    openConnection({
      deviceId: "dev-mac",
      deviceName: "Mac Studio",
      handoff: {
        roomResponse: {} as never,
        roomJoinContext: { kind: "device_room", deviceId: "dev-mac", forceJoin: false, occupiedAtJoin: false },
        remoteBootstrap: {} as never,
      },
    });
    attachRemoteSession("dev-mac", session);
    publishRemoteSessionState("dev-mac", {
      appControlId: "ctrl-1",
      connectionPath: "direct",
      dataChannels: { control: "open", text: "open", file: "open" },
      debugEvents: [],
      remoteTrackCount: 1,
      stage: "connected",
      videoElement: { event: "playing", currentTimeMs: 1000, width: 1920, height: 1080, readyState: 4 },
    });

    const replies: Array<{ request_id: string; ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }> = [];
    const viewerControls: Array<Record<string, unknown>> = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url === "/__uubridge/agent/state") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            policies: {
              "uu:dev-mac": {
                session_id: "uu:dev-mac",
                device_id: "dev-mac",
                authorized: true,
                human_paused: false,
                auto_pause_on_human_input: true,
                agent_control_enabled: true,
                control_allowed: true,
                busy: false,
                has_held_inputs: false,
              },
            },
          }),
        } as Response;
      }
      if (url === "/__uubridge/agent/reply") {
        replies.push(body);
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === "/__uubridge/agent/viewer-control") {
        viewerControls.push(body);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            session: {
              session_id: "uu:dev-mac",
              device_id: "dev-mac",
              authorized: true,
              human_paused: body.operation === "pause",
              auto_pause_on_human_input: true,
              agent_control_enabled: true,
              control_allowed: body.operation !== "pause",
              busy: false,
              has_held_inputs: false,
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const runtime = new LocalAgentBridgeRuntime();
    runtime.start();
    const es = FakeEventSource.instances[0];
    expect(es).toBeDefined();
    es.emit("hello", { protocol: "uubridge-agent/1", tab_id: "tab_1" });
    await vi.waitFor(() => expect(document.getElementById("uubridge-agent-bar")?.shadowRoot?.textContent).toContain("Agent 已授权控制"));

    // Sequence: click -> scroll down (macOS desktop flips vertical delta negative) -> type_text -> hotkey
    es.emit("command", {
      request_id: "cmd_seq",
      method: "action",
      params: {
        device_id: "dev-mac",
        observe_after: false,
        plan: {
          type: "sequence",
          interval_ms: 0,
          actions: [
            { type: "click", absX: 640, absY: 360, surfaceWidth: 1920, surfaceHeight: 1080, uuButton: "primary", modifiers: [] },
            { type: "scroll", absX: 640, absY: 360, surfaceWidth: 1920, surfaceHeight: 1080, direction: "down", ticks: 2, modifiers: [] },
            { type: "type_text", text: "你好 UU" },
            { type: "hotkey", keys: [{ name: "META", code: 117 }, { name: "C", code: 31 }], duration_ms: 10 },
          ],
        },
      },
    });

    await vi.waitFor(() => expect(replies.some((r) => r.request_id === "cmd_seq")).toBe(true));
    const seqReply = replies.find((r) => r.request_id === "cmd_seq");
    expect(seqReply?.ok).toBe(true);
    expect(seqReply?.result?.sequence).toEqual({ action_count: 4, finished_actions: 4 });
    expect(session.sendMouseScroll).toHaveBeenCalledWith({ deltaX: 0, deltaY: -120 });
    expect(session.sendTextInput).toHaveBeenCalledWith("你好 UU");
    expect(session.sendKeyboardInput).toHaveBeenCalledWith({ action: "keyboardPress", value: 117 });
    expect(session.sendKeyboardInput).toHaveBeenCalledWith({ action: "keyboardRelease", value: 117 });

    // Clipboard get & set
    es.emit("command", { request_id: "cmd_clip_set", method: "clipboard_set", params: { device_id: "dev-mac", text: "copy-me" } });
    es.emit("command", { request_id: "cmd_clip_get", method: "clipboard_get", params: { device_id: "dev-mac", timeout_ms: 500 } });
    await vi.waitFor(() => expect(replies.some((r) => r.request_id === "cmd_clip_get")).toBe(true));
    expect(replies.find((r) => r.request_id === "cmd_clip_set")?.ok).toBe(true);
    expect(replies.find((r) => r.request_id === "cmd_clip_get")?.result).toEqual({
      text: "remote-copied-text",
      source: "remote",
    });

    // Human clicks Pause button in Shadow DOM bar -> immediately releases inputs and reports pause
    const barRoot = document.getElementById("uubridge-agent-bar")?.shadowRoot;
    const pauseBtn = barRoot?.getElementById("toggle-pause") as HTMLButtonElement | null;
    expect(pauseBtn).not.toBeNull();
    pauseBtn?.click();

    await vi.waitFor(() => expect(viewerControls.some((c) => c.operation === "pause")).toBe(true));
    expect(session.releaseAllInputs).toHaveBeenCalled();

    // Theme switching defaults to system and toggles light/dark cleanly
    const darkBtn = barRoot?.querySelector<HTMLButtonElement>('[data-theme-mode="dark"]');
    const lightBtn = barRoot?.querySelector<HTMLButtonElement>('[data-theme-mode="light"]');
    darkBtn?.click();
    expect(document.documentElement.dataset.uubridgeTheme).toBe("dark");
    expect(document.getElementById("uubridge-theme-override")).not.toBeNull();
    lightBtn?.click();
    expect(document.documentElement.dataset.uubridgeTheme).toBe("light");
    expect(document.getElementById("uubridge-theme-override")).toBeNull();

    runtime.stop();
  });
});
