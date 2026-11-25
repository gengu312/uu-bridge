---
name: hitl-gui-mcp-architect
description: Design, implement, or security-audit Human-in-the-Loop (HITL) GUI and computer-use MCP servers (remote desktop, VNC/RDP/WebRTC, browser, mobile simulator, or native OS automation). Enforces observation-bound coordinates, idempotent actions, dual-channel human takeover, leased held inputs, and structured error recovery.
---

# HITL GUI MCP Architect

Build or harden Model Context Protocol (MCP) servers that let AI agents observe and control graphical interfaces while keeping a human firmly in charge.

Use this skill whenever the user wants to:
- **Architect or scaffold** a new computer-use, remote-desktop, browser, Electron, or simulator MCP server.
- **Audit and harden** an existing GUI automation MCP server against stale clicks, duplicate side effects, stuck keys, privilege escalation, or token leaks.
- **Standardize** MCP tool schemas, observation metadata, and error recovery semantics across vision-driven agent workflows.

## Why Naive GUI MCP Servers Fail in Production

Most first-draft computer-use MCP servers expose bare `screenshot()`, `click(x, y)`, and `type(text)` calls. In real workloads they fail in six repeatable ways:

1. **Coordinate drift & stale clicks:** The window resizes, DPI changes, monitor switches, or a modal pops up between screenshot and click—sending input to the wrong button.
2. **Duplicate side effects:** An action times out after partially executing; the LLM retries and double-submits a form, payment, or destructive command.
3. **Stuck keys or mouse buttons:** The agent crashes, times out, or gets cancelled between `key_down` / `mouse_down` and release, leaving the host desktop unusable.
4. **Human-agent fighting & self-escalation:** The agent keeps injecting input while the user grabs the mouse, or calls its own `enable_control` tool to bypass observe-only mode.
5. **Credential leakage into LLM context:** Helper tools return authenticated URLs, session cookies, or host tokens in tool outputs, leaking secrets into model logs.
6. **Latency death by chatty loops:** Performing click → select-all → type → enter → sleep → screenshot takes 6 model turns instead of 1 deterministic sequence.

## Operating Modes

Choose the mode matching the user's request:

### Mode 1: Design & Scaffold (New Server)
1. Identify the target transport (local OS API, WebRTC/VNC/RDP stream, CDP/Playwright, mobile simulator, or browser bridge) and confirm threat boundaries.
2. Enforce all **7 Core Invariants** below when drafting the protocol spec, MCP tool definitions, broker state machine, and server implementation.
3. Use the reference JSON Schemas, coordinate projection math, and idempotency algorithm in [references/protocol-contract.md](references/protocol-contract.md).
4. Generate a matching automated test matrix covering every invariant from [references/security-audit-checklist.md](references/security-audit-checklist.md).

### Mode 2: Audit & Harden (Existing Server)
1. Inspect the existing MCP tool definitions, transport/auth handlers, screenshot pipeline, and input dispatcher.
2. Score the implementation against the 20-point checklist in [references/security-audit-checklist.md](references/security-audit-checklist.md).
3. Report findings grouped by severity (**Critical**, **High**, **Medium**) with exact file/line evidence and concrete remediation patches.
4. Prioritize human sovereignty, secret non-leakage, stale-observation rejection, and held-input leases before ergonomic improvements.

---

## The 7 Core Architectural Invariants

Every production HITL GUI MCP server must enforce these invariants at the broker/server boundary—never rely on prompt instructions alone.

### Invariant 1: Immutable Observation Binding & Image-Space Coordinates
- Every capture (`screenshot`, `wait`, or `observe_after`) mints an immutable `observation_id` bound to:
  - `session_id`
  - `generation` (monotonic counter incremented on reconnect or target change)
  - `geometry_epoch` (incremented on resolution, scale/DPI, window bounds, or display change)
  - `source_size` (`{ width, height }` of the native capture surface)
  - `region` (crop rect in `source_size` pixels)
  - `image_size` (`{ width, height }` of the resized PNG returned to the model)
- **Rule:** Action tools MUST require `observation_id` and accept coordinates **only in `image_size` pixel space**. The server projects `(x, y)` back through `region` and `source_size` to target coordinates. Reject stale or mismatched observations with `OBSERVATION_STALE` (HTTP 409).
- **Eviction:** Bound observation cache size and TTL (e.g., 256 entries / 10 min) so memory stays flat.

### Invariant 2: Strict Idempotency & Uncertainty Semantics
- Every mutating tool (`action`, `clipboard_set`, etc.) MUST require a client-generated `operation_id` (`^[a-zA-Z0-9._:-]{1,128}$`).
- Canonicalize the request payload (sorted object keys) and cache outcomes in a bounded LRU/TTL store (e.g., 128 entries / 5 min):
  - Same `operation_id` + identical canonical payload → return the cached outcome (or `in_flight` wait/dedup) without re-executing.
  - Same `operation_id` + different payload → reject with `OPERATION_CONFLICT` (HTTP 409).
- Every structured error MUST declare two explicit booleans:
  - `retryable`: whether retrying the same intent can succeed.
  - `side_effect_possible`: `true` if input may have already been dispatched before failure/timeout.
- Instruct MCP clients: **never** replay a `side_effect_possible: true` failure under a new `operation_id` without capturing a fresh screenshot first.

### Invariant 3: Human Sovereignty & Dual-Channel Auth Isolation
- Default every newly connected session to **Observe-Only** (`control_authorized: false`).
- Split authentication into two non-interchangeable channels:
  1. **Human Control Channel** (e.g., `HttpOnly` SameSite cookie or native desktop UI button): the *only* authority allowed to grant control, pause, or resume from pause.
  2. **Agent Tool Channel** (e.g., separate bearer token stored in a `0600` local file): can read state, capture frames, send actions while authorized, and **only downgrade** its own control (`set_control(enabled: false)`). It can NEVER grant initial authorization or clear `HUMAN_PAUSED`.
- **Auto-Pause on Human Activity:** Any real human pointer click/drag or keystroke on the controlled view immediately sets `HUMAN_PAUSED`, cancels in-flight sequences, and releases all held inputs.
- **Zero Secret Leakage:** Helper tools like `open_panel` may launch the local browser directly on the host OS, but MUST NEVER return login URLs containing tokens, cookies, or credentials in MCP tool responses.

### Invariant 4: Bounded Sequences + Built-In Visual Settlement
- Support both single actions and a **bounded `sequence`** (e.g., 1–8 actions, max total duration 8,000 ms, configurable `interval_ms` capped at 500 ms).
- Re-check `HUMAN_PAUSED`, `CONTROL_DENIED`, `generation`, and `geometry_epoch` **before every step** inside a sequence—abort immediately if anything shifts mid-sequence.
- Default `observe_after: true` on action tools: wait briefly for visual `changed` or `stable` (capped e.g. 5,000 ms) using frame diffing on the target region, then return the new PNG + `observation_id` in the same tool response.
- Provide a dedicated `wait(observation_id, condition: "changed" | "stable", timeout_ms)` tool (capped e.g. 25,000 ms) so agents never resort to shell `sleep` loops.

### Invariant 5: Leased Held Inputs & Mandatory Release
- Continuous state inputs (`key_down`, `mouse_down`) MUST carry a server-enforced TTL lease (recommended: **15 seconds**).
- Refresh the lease only on subsequent actions; when the lease expires—or on **any** error, timeout, `HUMAN_PAUSED`, display switch, disconnect, or sequence abort—automatically invoke `releaseAllInputs()` on the target session.
- Always expose an explicit `release_inputs(session_id)` tool that works even during recovery.

### Invariant 6: Machine-Actionable Error Taxonomy
- Never collapse errors into generic text strings. Emit a consistent structured error object (`code`, `message`, `retryable`, `side_effect_possible`, optional `reason`/`details`) with clean separation between:
  - **400** `INVALID_ARGUMENT`
  - **401** `UNAUTHORIZED`
  - **403** `ORIGIN_REJECTED`, `CONTROL_DENIED`, `HUMAN_PAUSED`
  - **404** `SESSION_NOT_FOUND`, `OBSERVATION_NOT_FOUND`, `DISPLAY_NOT_FOUND`
  - **409** `OPERATION_CONFLICT`, `OBSERVATION_STALE`, `SESSION_BUSY`, `SESSION_NOT_READY`, `HELD_INPUT_ACTIVE`, `VIDEO_STALLED`
  - **503** `CONTROLLER_UNAVAILABLE`, `CLIENT_OFFLINE`
  - **504** `TIMEOUT`

### Invariant 7: Loopback-First Transport & Explicit Capability Boundaries
- Bind local control brokers strictly to `127.0.0.1` / `localhost`, validate `Origin` / `Host` headers on mutating HTTP/WS endpoints, and restrict local handoff files to owner-only permissions (`0600`).
- Document unsupported OS primitives honestly (e.g., lack of accessibility tree, lock-screen state, or clipboard polling on specific platforms) instead of fabricating brittle workarounds.

---

## Deliverable Structure

When executing **Design & Scaffold Mode**, always output:
1. **Trust & Channel Diagram** (showing Human Control Channel vs Agent MCP Channel and token boundaries).
2. **MCP Tool Contract** (minimal, cohesive toolset: discovery/panel, session wait, screenshot, action+sequence, visual wait, release inputs, set control, optional clipboard/display/disconnect).
3. **State Machine & Guardrail Constants** (table of limits, TTLs, and abort triggers).
4. **Verification Test Plan** (concrete unit/integration test cases proving every invariant).

When executing **Audit & Harden Mode**, always output:
1. **Scorecard Summary** (pass/fail/partial across the 5 audit domains).
2. **Prioritized Findings** (Critical → Medium, each with exploit/failure scenario + minimal fix).
3. **Regression Tests to Add** (targeting the exact gaps found).

Read [references/protocol-contract.md](references/protocol-contract.md) for reusable schemas and algorithms, and [references/security-audit-checklist.md](references/security-audit-checklist.md) for the full 20-point review checklist.
