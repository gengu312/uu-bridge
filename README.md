# UU Bridge

<p>
  <a href="./README.md"><img src="https://img.shields.io/badge/Docs-English-2563EB?style=flat-square" alt="English" /></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-64748B?style=flat-square" alt="简体中文" /></a>
</p>

This project includes two independent local web entry points (along with a built-in MCP server):

- `http://127.0.0.1:18787`: Official client window viewer bridge. Video capture has been verified against the real UU client; UU 4.46.0 does not accept background simulated input, so the input toggle for real UU windows is disabled. The built-in verification window can still be used to test native input.
- `http://127.0.0.1:18787/web-controller`: Convenient entry point for the standalone open-source UU web controller, running internally on `127.0.0.1:18789` with source code in `vendor/uu-web`. It transmits video, keyboard, and mouse input directly over the UU protocol and requires signing in to your UU account once inside the self-hosted web UI; it never extracts credentials from the official client. The entry point automatically establishes a local session without copying or exposing token-bearing URLs. Build completion and actual remote control after sign-in must be verified separately.
- `npm run mcp` (`agent/mcp-server.mjs`): A local **MCP (Model Context Protocol) remote-control server** inspired by the engineering design of [CrossDesk MCP](https://github.com/kunkundi/crossdesk). With zero added external dependencies, it bridges the UU web controller open in your browser via a standalone Agent Broker on `127.0.0.1:18789`, enabling AI Agents to safely and reliably observe and operate a remote computer while preserving real-time human viewing and one-click takeover.

Sign-in, connection management, and network transport for the window bridge are handled entirely by the official client; it does not read accounts, verification codes, or login state. The web controller is an independent service, not a re-stream of the official client's window.

## Running

Once the standalone web controller is set up, run `npm run start:web` from the project root while keeping the original bridge service running with `npm start`. Then open <http://127.0.0.1:18787/web-controller>, or click "Open Local UU Web Controller" ("打开本地 UU 网页主控") on the original page. Sign in to UU in the self-hosted web UI; if the official local controller client is still occupying the same target device, disconnect its control session first before connecting to that device from the web UI. The remote machine continues running the official UU controlled client.

For first-time setup of the standalone web controller, run the one-command setup script (automatically fetches [ofoz/uu_web](https://github.com/ofoz/uu_web) at a pinned baseline commit, applies minimal local bridge adaptations from `integration/uu-web/`, and builds in `shared → backend → frontend` order while preserving the upstream MIT license):

```bash
npm run setup:web
```

On subsequent launches, simply run `npm run start:web` and `npm start`—no repeated installation or build is needed. Both local pages support **Light / Dark themes (following system preference by default)** and can be switched manually in the UI at any time.

The commands below start only the original official-client window viewer bridge:

Requires macOS 14+, Xcode Command Line Tools (including Swift), and Node.js 22+. No npm dependency installation, no Docker, and no external server required.

```bash
npm run build
npm start
```

Open <http://127.0.0.1:18787>. The service listens on localhost only; stop the terminal process to shut down the bridge. If the port is occupied, run `PORT=18788 npm start`.

1. Sign in and connect to the remote computer in the official UU client.
2. Refresh the window list in the web UI and select the corresponding UU window.
3. Grant Screen Recording and Accessibility permissions as prompted by the web UI, then refresh permission status.
4. Click Start Stream. Real UU windows are view-only through this entry point; use the standalone web controller for actual remote control. The input toggle is open only to this project's built-in verification window.

The local verification window supports in-frame left-click, right-click, drag, scroll, common keys, and sidebar text input. Sent text is inserted at the current cursor position without automatically overwriting existing content. In testing, `Command+A` did not take effect on the background macOS verification window, while standard `Backspace` works. These verification results do not imply that the official UU client accepts background input.

## Permissions

The native app bundle is located at `.build/UU Bridge.app`. macOS may attribute permission requests to the terminal app or OpenChamber that launched it—grant permissions to whichever application macOS prompts for under **System Settings → Privacy & Security → Screen & System Audio Recording / Accessibility**. Refresh status after granting; if macOS requires quitting and reopening, restart the bridge service.

This project never modifies system permission databases or bypasses macOS confirmation prompts. Screenshots are not saved to disk automatically; endpoints only allow capturing selected UU or verification windows, and native input is restricted exclusively to the built-in verification window. It will never hijack local mouse/keyboard focus to work around UU input restrictions.

## Verification

"Local Input Verification" ("本机输入验证") in the web UI opens an isolated, harmless window. Select that window, click the counter button from the browser, focus the text input, and send text. Input uses the exact same path as UU; however, frames are rendered directly by the verification window's own view without reading the screen, allowing closed-loop verification between browser and native input even without Screen Recording permission. The web UI explicitly marks this as "App Self-Rendered" ("应用自身绘制"); passing this check does not prove that real UU `ScreenCaptureKit` capture has passed.

```bash
npm test
npm run verify:local
```

`verify:local` requires the server to be running. It opens the project's verification window and checks background clicks, Unicode text input, Backspace, stale-target rejection, and late-input rejection after release. It does not request OS permissions or connect to any remote machine. API protection tests verify local request authentication, origin validation, and input validation only—they do not equate to passing real window capture or remote operations. See `VERIFICATION.md` for actual verification records.

## MCP Remote Agent Control (Recommended, via UU Web Controller)

Inspired by CrossDesk MCP's remote Agent control design, the local UU web controller (`127.0.0.1:18789`) includes a built-in lightweight **Agent Broker** (`agent/broker.mjs`) and a zero-intrusion browser collaboration control bar (Shadow DOM, without refactoring upstream pages).

### 1. Startup & Connection Workflow

1. Start the local UU web controller (and optionally the original bridge redirect entry):
   ```bash
   npm run start:web
   npm start
   ```
2. Open <http://127.0.0.1:18787/web-controller> in your local browser (or read `loginUrl` from `output/uu-web-local-access.json`), sign in to UU yourself, and connect to the target remote device.
3. Configure the standard stdio MCP Server in your MCP client (Codex / Claude Code / OpenCode / T3 Code, etc.):
   ```json
   {
     "mcpServers": {
       "uubridge": {
         "command": "node",
         "args": ["/path/to/uu-bridge/agent/mcp-server.mjs"]
       }
     }
   }
   ```
4. Connections start in **Observe-Only** mode by default. Once you confirm the stream looks normal, click **"Allow Agent Control"** ("允许 Agent 控制") in the **Agent Collaboration Bar** at the bottom-right corner of the page to authorize control. At any moment, click **"Pause & Take Over"** ("暂停接管"), click **"Release Inputs"** ("释放按键"), or **simply move/click/type directly on the remote stream (triggers auto-pause by default)** to immediately interrupt running actions and reclaim control.

### 2. Core Engineering Mechanisms

- **Pixel-Accurate Native Frame Capture & Direct UU Protocol Transport**: Crops/scales and exports PNGs directly from the WebRTC `<video>` at native resolution (free of web UI chrome), and sends mouse/keyboard events, Chinese/Unicode `text_input`, and clipboard updates natively over `BrowserRemoteSession`'s UU DataChannel—without relying on local macOS `CGEvent` injection.
- **Dual-Channel Authentication Isolation**: Browser collaboration routes (`/__uubridge/agent/*`) accept only the `HttpOnly` local session cookie; Agent routes (`/__uubridge/mcp/*`) accept only the independent `agentToken` stored in `output/uu-web-local-access.json` (mode `0600`). Agents cannot call `viewer-control` to self-authorize or clear a human pause; `uu_open_panel` never leaks login tokens or passwords into model context.
- **Observation Binding & Error Prevention**: Every screenshot issues an immutable `observation_id`, `generation`, `geometry_epoch`, `image_size`, and `region`. All action coordinates are based on the pixel space of the latest screenshot and automatically mapped back to source video coordinates; resolution changes, display switches, or reconnections immediately invalidate stale observations.
- **Idempotent Operations & Multi-Step Sequences**: `uu_action` enforces an `operation_id` (128-entry / 5-minute cache; parameter conflicts return `OPERATION_CONFLICT`), supports 1–8 step `sequence` batches, and defaults to `observe_after: true` to wait in-browser for visual change/stability before returning a fresh PNG frame alongside the action result.
- **Hold Leases Against Stuck Keys**: `key_down` / `mouse_down` carry an automatic 15-second expiration lease; timeouts, errors, display switches, disconnects, or human pauses automatically execute `releaseAllInputs()`.

### 3. MCP Tool Reference

- `uu_open_panel`: Check local UU web controller status and optionally open the system browser (without leaking tokens).
- `uu_list_sessions` / `uu_get_session`: List connected devices or wait with a bounded timeout (≤25s) until a device session is ready.
- `uu_screenshot`: Capture a full-screen or cropped-region PNG (returns a standalone MCP `image` content block + observation metadata).
- `uu_action`: Execute a single action (`click` / `double_click` / `move` / `mouse_down` / `mouse_up` / `scroll` / `drag` / `key_press` / `key_down` / `key_up` / `hotkey` / `type_text`) or a 1–8 step `sequence`.
- `uu_wait`: Wait for the previously observed region to visually change (`changed`) or stabilize (`stable`) and return the latest screenshot.
- `uu_release_inputs`: Immediately release all held keys/mouse buttons and abort any running sequence.
- `uu_set_control`: Toggle Agent control on/off within the scope already authorized by the human user and while not paused (cannot escalate privileges).
- `uu_clipboard_get` / `uu_clipboard_set`: Read/write remote plain-text clipboard (active clipboard read currently primarily supports macOS controlled hosts; Windows depends on remote copy notifications).
- `uu_select_display`: Switch between remote multi-stream video sources (multi-monitor) and invalidate old observations.
- `uu_disconnect`: Disconnect from the remote device and release all inputs.

> Boundary Note: The UU protocol itself does not provide remote OS native accessibility trees (AX/UIA), lock-screen state queries, or a standalone file transfer channel; therefore CrossDesk's `desktop_automation` / `unlock` / `files` tools are not included.

### 4. Agent Skills (`SKILL.md`)

The `skills/` directory provides two Agent skills conforming to the open `SKILL.md` specification, ready to copy directly into the skills folder of Claude Code / Cursor / Codex / Gemini CLI, or package for skill marketplaces:

- **[`skills/uu-bridge-mcp/`](skills/uu-bridge-mcp/SKILL.md)** (Companion Operational Skill): Used alongside this project's `uubridge` MCP Server to guide Agents in following strict operational invariants—"zero credential leakage, observe before clicking, image-pixel coordinate space, `operation_id` idempotency, and respecting `CONTROL_DENIED` / `HUMAN_PAUSED` human takeover"—complete with a 12-tool and error-code quick reference (`references/tool-reference.md`). Contains operational guidance only, with no third-party protocol code.
- **[`skills/hitl-gui-mcp-architect/`](skills/hitl-gui-mcp-architect/SKILL.md)** (Vendor-Agnostic Architecture & Audit Skill): Distills the human-in-the-loop GUI MCP engineering invariants developed in this project into a protocol-independent guide, including 7 production invariants, reusable JSON Schemas, coordinate projection & idempotency cache references (`references/protocol-contract.md`), plus a 20-item security/reliability audit checklist and minimum test matrix (`references/security-audit-checklist.md`)—applicable to WebRTC, VNC, RDP, Playwright, emulator, or native OS automation MCP servers.

## Original Client Bridge Agent API (View-Only / Local Verification Window)

First call `GET /api/session` on localhost to obtain the session token for the running server process; pass it in the `X-UUBridge-Token` request header on all other endpoints.

- `GET /api/status`: Permission and client status.
- `GET /api/windows`: Selectable UU / verification windows.
- `POST /api/select`, `{"windowId":123}`: Select a target window; returns `selectedId` and `selectionVersion`.
- `GET /api/frame?windowId=123&selectionVersion=1`: JPEG screenshot in memory (never written to disk); response headers include target ID and selection version.
- `POST /api/input`: Available exclusively for the built-in verification window. Every request carries the selected `windowId` and `selectionVersion`; `x` and `y` are `0–1` coordinates relative to the captured window. Rejects input if selection was changed by another page; real UU windows return `UU_INPUT_UNSUPPORTED`.
- `POST /api/release`: Carries current `windowId` and `selectionVersion`, releases mouse buttons, and invalidates that selection version to block late-arriving inputs after page close; re-select or read the latest version to continue operating.

Example click payload: `{"windowId":123,"selectionVersion":1,"type":"click","x":0.5,"y":0.5,"button":"left"}`; text and key inputs carry the same target fields along with `{"type":"text","text":"你好"}` or `{"type":"key","key":"Enter"}`. Responses report command dispatch only and do not guarantee remote task completion; Agents must fetch a new screenshot to confirm.

## Implementation & Boundaries

The original client bridge uses Swift + `ScreenCaptureKit` single-window capture, Core Graphics input for the verification window, Node's built-in HTTP server, and vanilla frontend pages. Frames are captured on demand (pulled roughly every 500ms by default), with no audio or high-frame-rate streaming. This bridge copies no third-party implementation; the standalone protocol controller preserves upstream MIT code and directory structure.

Captured windows preserve aspect ratio while ignoring window shadows, mapping input coordinates back to the original window bounds. Window close, minimize, resize, UU privacy mode, or OS permission changes may affect capture. Background synthetic events and UU's forwarding behavior to remote hosts must be verified separately and cannot be inferred from local verification window results.

Background mouse positioning requires Apple's undocumented `CGEventSetWindowLocation` SPI and event window fields (referencing [WebKit test SPI declarations](https://github.com/WebKit/WebKit/blob/main/Tools/TestRunnerShared/spi/CoreGraphicsTestSPI.h)). Availability is checked dynamically at runtime with explicit errors if absent. Verified working locally, though future macOS releases may affect compatibility. No WebKit source code is copied or embedded.

Official API documentation references: [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), [CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent), [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

## References & Acknowledgements

- **[ofoz/uu_web](https://github.com/ofoz/uu_web)** (based on **[iola1999/uurc-web](https://github.com/iola1999/uurc-web)**, MIT License): Provides the standalone local UU web controller protocol implementation. Fetched into `vendor/uu-web/` via `scripts/setup-web.mjs` with outer localhost authentication and minimal Agent bridge adaptations, preserving the upstream directory structure and `LICENSE` in full.
- **[kunkundi/crossdesk](https://github.com/kunkundi/crossdesk)** (GPL-3.0 License): The MCP tool contracts and human-in-the-loop safety mechanisms under `agent/` (`observation_id` observation binding, `operation_id` idempotency cache, 1–8 step `sequence` + `observe_after` visual waiting, 15-second hold leases with one-click input release, and non-overridable human hard pause) **reference its architecture and protocol concepts only, and are implemented completely from scratch in Node.js without copying, porting, or linking any CrossDesk source code**.
- **[WebKit CoreGraphicsTestSPI.h](https://github.com/WebKit/WebKit/blob/main/Tools/TestRunnerShared/spi/CoreGraphicsTestSPI.h)**: Referenced solely for declared macOS private SPI function signatures; no WebKit source code is copied or embedded.

## License & Disclaimer

- **License**: Original code and documentation in this repository (`agent/`, `skills/`, `server.mjs`, `public/`, `native/`, `scripts/`, `integration/`, `test/`) are open-sourced under the **[MIT License](LICENSE)**; third-party web controller code fetched into `vendor/uu-web/` remains under its original MIT License.
- **Unofficial Statement**: This project is an independent personal open-source experiment and local utility, with no affiliation, partnership, or authorization from NetEase UU Remote.
- **Compliance & Security Boundaries**: Strictly for personal study and local use on devices with explicit authorization (listens only on `127.0.0.1` by default). Never extracts official client credentials or bypasses OS permission prompts. Do not use this tool for unauthorized remote access; users are responsible for complying with local laws, regulations, and third-party terms of service.
