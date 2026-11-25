---
name: uu-bridge-mcp
description: Operate a remote computer safely through the local uu-bridge MCP server (gengu312/uu-bridge) with human-in-the-loop approval, observation-bound coordinates, idempotent action sequences, and instant human takeover. Use when the user asks to view or control a remote desktop connected via uu-bridge.
---

# UU Bridge MCP Operator

Guide AI agents to observe and operate a remote computer through the open-source local **uu-bridge** MCP server (`https://github.com/gengu312/uu-bridge`, MIT License).

> **Scope & Safety Notice:** `uu-bridge` is an independent, unofficial local-only tool (`127.0.0.1`). It requires the user to run the local web controller and sign into their own remote session in their local browser. This skill contains operational instructions only; it bundles no third-party protocol binaries or credentials.

## Prerequisites (User-Managed Local Setup)

Before using the MCP tools, the user must have `uu-bridge` running locally and registered as a stdio MCP server:

1. Local controller running on loopback (`npm run start:web` in the `uu-bridge` repository).
2. MCP client configured to launch `node /path/to/uu-bridge/agent/mcp-server.mjs`.
3. User signed in through their local browser (`http://127.0.0.1:18787/web-controller`), connected to the target device, and explicitly toggled **"允许 Agent 控制"** (Allow Agent Control) in the bottom-right collaboration bar.

## Non-Negotiable Safety Rules

1. **Never request credentials in chat.** Never ask the user for UU account passwords, SMS verification codes, remote OS passwords, or local auth tokens. Direct them to the local browser panel via `uu_open_panel`.
2. **Respect human sovereignty.**
   - `CONTROL_DENIED` means the session is in Observe-Only mode. You may inspect screenshots, or ask the user to enable Agent control in the browser bar.
   - `HUMAN_PAUSED` means the human clicked Pause or interacted with the remote canvas directly. Stop sending input immediately, inform the user, and wait until they resume. Never attempt to bypass or spam retries.
3. **Always observe before acting.** Never guess coordinates or reuse an `observation_id` after display switching, resolution changes, or reconnection.
4. **Enforce strict idempotency.**
   - Generate a unique `operation_id` for each distinct logical action (e.g., `op_click_submit_01`).
   - Reuse the same `operation_id` **only** to re-query the exact same payload.
   - If an action fails with `side_effect_possible: true` or `outcome_unknown`, **never** blindly replay it under a new `operation_id`. Call `uu_screenshot` first to verify whether the action already took effect.
5. **Confirm destructive remote actions.** Ask the user before executing irreversible operations on the remote machine (deleting files, submitting payments/orders, shutting down/rebooting, modifying system security settings, or sending external messages).

## Standard Operating Workflow

Follow this loop for every remote task:

### 1. Discover or Wait for a Ready Session
1. Call `uu_list_sessions` first.
2. If the controller is offline (`WEB_CONTROLLER_UNAVAILABLE`), tell the user to run `npm run start:web` in their `uu-bridge` workspace.
3. If no remote session is connected, call `uu_open_panel(open_browser: true)` and ask the user to sign in, connect the target device, and enable **"允许 Agent 控制"**.
4. While waiting for the user or video stream readiness, call `uu_get_session(wait_ms: 25000)` (bounded wait). Repeat only while a task is actively pending.

### 2. Capture an Observation
1. Call `uu_screenshot(session_id)` to capture a clean PNG frame from the remote WebRTC video stream.
2. Record the returned `observation_id`, `image_size`, and `source_size`.
3. **Coordinate Rule:** Every `(x, y)` passed to `uu_action` MUST be in the **returned PNG `image_size` pixel space**, not the remote OS desktop resolution. The broker maps image coordinates back to source video coordinates automatically.
4. For dense UIs or small targets, pass `region: { x, y, width, height }` (in `source_size` pixels) to capture a high-detail crop and click within that crop's returned `image_size`.

### 3. Execute Actions Efficiently & Safely
1. Call `uu_action` with:
   - `session_id`
   - `operation_id` (unique per logical step)
   - `observation_id` (the latest valid observation)
   - `action` (single action or a 1–8 step `sequence`)
2. **Prefer short deterministic sequences** (1–8 steps, e.g., `click` input box → `hotkey(["CTRL", "A"])` → `type_text` → `key_press("ENTER")`) when no intermediate visual decision is required.
3. Keep `observe_after: true` (default) so `uu_action` waits briefly for visual settlement and returns a fresh PNG + new `observation_id` in one round trip.
4. For slower transitions (app launch, page navigation, build output), use `uu_wait(session_id, observation_id, condition: "changed" | "stable", timeout_ms: 10000)` instead of blind loops.

### 4. Clipboard, Multi-Display, and Held-Input Hygiene
- **Text entry:** Prefer `type_text` for Unicode/CJK and normal text. Use `uu_clipboard_set` + paste hotkey (`["META", "V"]` on macOS, `["CTRL", "V"]` on Windows/Linux) for large blocks. Note that `uu_clipboard_get` active polling is primarily supported on macOS remote hosts.
- **Multi-monitor:** Check `displays` from `uu_list_sessions`. Call `uu_select_display(session_id, display_index)` to switch monitors, then **immediately take a fresh `uu_screenshot`** because switching displays invalidates prior observations and releases held inputs.
- **Held inputs (`key_down` / `mouse_down`):** Held inputs auto-expire after 15 seconds. Always pair with `key_up` / `mouse_up` or call `uu_release_inputs` immediately after finishing a drag/modifier hold or encountering any error.

### 5. Clean Handback
- When finished, call `uu_release_inputs` if any hold actions were used.
- Optionally call `uu_set_control(session_id, enabled: false)` to drop back to observe-only mode.
- Only call `uu_disconnect` if the user explicitly asked to disconnect the remote session.

## Error Recovery Quick Reference

| Error Code | Meaning | Required Agent Behavior |
|---|---|---|
| `WEB_CONTROLLER_UNAVAILABLE` | Local `127.0.0.1:18789` controller not running | Ask user to run `npm run start:web`; do not spin-retry |
| `BROWSER_OFFLINE` | Controller running, but no browser tab open | Call `uu_open_panel(open_browser: true)` and ask user to open/connect |
| `SESSION_NOT_READY` | Device connected, video stream still initializing | Call `uu_get_session(session_id, wait_ms: 25000)` |
| `CONTROL_DENIED` | Observe-only mode (user has not granted control) | Stop input; ask user to click **"允许 Agent 控制"** |
| `HUMAN_PAUSED` | Human paused or took over mouse/keyboard | Stop immediately; wait for human confirmation before resuming |
| `OBSERVATION_STALE` | Display switched, resized, or reconnected | Call `uu_screenshot` to get a fresh `observation_id`, then re-evaluate |
| `OPERATION_CONFLICT` | Same `operation_id` reused with different parameters | Generate a fresh `operation_id` only after confirming state via `uu_screenshot` |
| `HELD_INPUT_ACTIVE` | A held key/button conflicts with the next action | Call `uu_release_inputs(session_id)` before continuing |
| `VIDEO_STALLED` / `TIMEOUT` | Remote frame stalled or action timed out | Inspect `side_effect_possible`; take `uu_screenshot` before deciding next step |

For full tool schemas, supported key names, and client configuration snippets, read [references/tool-reference.md](references/tool-reference.md).
