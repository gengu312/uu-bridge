# 20-Point HITL GUI MCP Security & Reliability Audit Checklist

Use this checklist when auditing an existing GUI/computer-use MCP server or writing the acceptance test suite for a new one.

## Domain A: Observation Integrity & Coordinates
- [ ] **A1. Mandatory observation binding:** Every pointer/input action requires a valid `observation_id`; raw blind coordinate clicks are rejected.
- [ ] **A2. Image-space projection:** Agent coordinates are interpreted in the returned image's pixel space (`image_size`) and projected through `region` → `source_size` on the server, never trusting client DPI assumptions.
- [ ] **A3. Geometry invalidation:** Window resize, DPI change, crop mismatch, or display switch increments `geometry_epoch` and rejects prior observations with `OBSERVATION_STALE`.
- [ ] **A4. Generation invalidation:** Reconnecting or switching the target window/session increments `generation` and rejects all prior observations.

## Domain B: Idempotency & Uncertainty
- [ ] **B1. Mandatory `operation_id`:** Every mutating tool validates a bounded identifier (`1–128` safe chars).
- [ ] **B2. Replay deduplication:** Re-sending the same `operation_id` with identical canonical arguments returns the prior outcome without re-dispatching input.
- [ ] **B3. Conflict rejection:** Re-sending the same `operation_id` with modified arguments returns `OPERATION_CONFLICT` (HTTP 409) and performs zero side effects.
- [ ] **B4. Explicit uncertainty flags:** Errors accurately set `retryable` and `side_effect_possible` so clients know when `outcome_unknown` requires a fresh screenshot before acting again.

## Domain C: Human Sovereignty & Auth Isolation
- [ ] **C1. Observe-only default:** New sessions start unauthorized for agent input until explicitly approved by a human action outside the agent channel.
- [ ] **C2. Non-escalation:** Agent tokens cannot call human authorization endpoints or clear `HUMAN_PAUSED` (even via `set_control(enabled: true)`).
- [ ] **C3. Instant human preemption:** Local human mouse/keyboard activity or clicking Pause immediately flips `HUMAN_PAUSED`, cancels in-flight sequences, and blocks subsequent agent input.
- [ ] **C4. Step-by-step preemption:** Multi-step sequences re-verify authorization, `HUMAN_PAUSED`, `generation`, and `geometry_epoch` before *each* sub-action.

## Domain D: Held-Input Safety & Bounds
- [ ] **D1. Held-input TTL lease:** `key_down` and `mouse_down` automatically expire and release after a short lease (e.g., 15s) if not released or renewed.
- [ ] **D2. Release-on-fault:** Any error, timeout, pause, display change, or disconnect invokes `releaseAllInputs()`.
- [ ] **D3. Bounded payloads:** Sequences, drag paths, text length, clipboard payloads, and wait timeouts all enforce strict schema caps.
- [ ] **D4. Visual settle wait:** Post-action observation and `wait` support `changed` / `stable` conditions with bounded timeouts instead of unbounded polling.

## Domain E: Transport & Secret Hygiene
- [ ] **E1. Loopback binding:** Local broker listens only on `127.0.0.1` / `localhost` by default; MCP client rejects non-loopback origins in local handoff configs.
- [ ] **E2. Origin & token verification:** Browser-facing endpoints validate `Origin` and `HttpOnly` session cookies; agent endpoints require a separate bearer token.
- [ ] **E3. Strict file permissions:** Local access/handoff files containing the agent bearer token are written with mode `0600` and excluded from VCS (`.gitignore`).
- [ ] **E4. Zero credential leakage:** `open_panel`, error messages, and session listings never leak login URLs with embedded tokens, cookies, SMS codes, or passwords into the LLM context.

## Minimum Automated Verification Suite

Before declaring a HITL GUI MCP server production-ready, verify these 8 automated tests pass:

1. **Stale observation test:** Trigger `geometry_epoch++` or `generation++` → assert `OBSERVATION_STALE` and zero dispatched input.
2. **Idempotency replay test:** Send same `operation_id` + same payload twice → assert target receives exactly 1 input event.
3. **Idempotency conflict test:** Send same `operation_id` + altered coordinates/text → assert `OPERATION_CONFLICT` and zero second dispatch.
4. **Non-escalation test:** Call `set_control(enabled: true)` on an unauthorized or `HUMAN_PAUSED` session using the agent bearer token → assert `CONTROL_DENIED` / `HUMAN_PAUSED`.
5. **Mid-sequence preemption test:** Start a 5-step sequence, trigger `HUMAN_PAUSED` after step 2 → assert steps 3–5 never execute and `releaseAllInputs()` fires.
6. **Lease expiry test:** Dispatch `key_down("SHIFT")` and advance timer past `HELD_INPUT_LEASE_MS` → assert `key_up("SHIFT")` / `releaseAllInputs()` fires automatically.
7. **Origin & auth boundary test:** Call human control endpoint with agent bearer token (no cookie) and call agent endpoint with wrong `Origin` / missing token → assert `401`/`403`.
8. **Secret redaction test:** Inspect `open_panel`, `list_sessions`, and error responses → assert none contain the raw `agentToken` or browser login token.
