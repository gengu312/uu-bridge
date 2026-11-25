# HITL GUI MCP Protocol Contract & Reference Algorithms

Reusable vendor-neutral specifications for building reliable Human-in-the-Loop GUI / Computer-Use MCP servers.

## 1. Dual-Channel Architecture

```text
+---------------------------+                +-----------------------------+
|  Human Browser / Native   |                |   AI Agent (MCP Client)     |
|  Collaboration Control UI |                |   Claude / Cursor / Codex   |
+-------------+-------------+                +--------------+--------------+
              |                                             | stdio (JSON-RPC)
              | HttpOnly SameSite Cookie                    v
              | (Can grant/pause/resume)     +-----------------------------+
              |                              |    Local stdio MCP Server   |
              |                              |  Reads 0600 access file for |
              |                              |  loopback origin + token    |
              v                              +--------------+--------------+
+-----------------------------------------------------------+--------------+
|                 Local Agent Broker (127.0.0.1 only)                      |
|  - Human endpoints: /human/*   (Cookie + Origin check)                   |
|  - Agent endpoints: /mcp/*     (Bearer agentToken only; never escalates) |
|  - Observation Store (LRU+TTL) | Operation Cache (LRU+TTL) | Input Lease |
+------------------------------------+-------------------------------------+
                                     |
                                     v
                        Target GUI / Remote Session
                  (WebRTC, VNC, RDP, CDP, Simulator, OS API)
```

## 2. Observation Metadata Schema

Every frame-returning tool (`screenshot`, `action` with `observe_after`, `wait`) returns both the image block and structured metadata:

```json
{
  "observation_id": "obs_9k2fA1...",
  "session_id": "session_main",
  "generation": 3,
  "geometry_epoch": 5,
  "frame_id": 1482,
  "captured_at": "2026-11-25T00:00:00.000Z",
  "source_size": { "width": 2560, "height": 1440 },
  "region": { "x": 0, "y": 0, "width": 2560, "height": 1440 },
  "image_size": { "width": 1280, "height": 720 }
}
```

### Server-Side Coordinate Projection Math

Given `(ix, iy)` submitted by the agent in `image_size` pixel space:

1. Validate `0 <= ix <= image_size.width` and `0 <= iy <= image_size.height`.
2. Project into the captured `region` inside `source_size`:
   ```text
   sx = region.x + (ix / image_size.width) * region.width
   sy = region.y + (iy / image_size.height) * region.height
   ```
3. Clamp to `[0, source_size.width - 1]` and `[0, source_size.height - 1]` (or normalize `nx = sx / source_size.width`, `ny = sy / source_size.height` for protocols expecting `[0, 1]` coordinates).
4. Reject immediately with `OBSERVATION_STALE` if:
   - `observation.session_id !== session.id`
   - `observation.generation !== session.generation`
   - `observation.geometry_epoch !== session.geometry_epoch`
   - `observation` expired or evicted from cache

## 3. Canonical Action & Bounded Sequence Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["session_id", "operation_id", "observation_id", "action"],
  "properties": {
    "session_id": { "type": "string", "pattern": "^[a-zA-Z0-9._:-]{1,128}$" },
    "operation_id": { "type": "string", "pattern": "^[a-zA-Z0-9._:-]{1,128}$" },
    "observation_id": { "type": "string", "pattern": "^[a-zA-Z0-9._:-]{1,128}$" },
    "action": {
      "oneOf": [
        { "$ref": "#/$defs/singleAction" },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "actions"],
          "properties": {
            "type": { "const": "sequence" },
            "interval_ms": { "type": "integer", "minimum": 0, "maximum": 500, "default": 100 },
            "actions": {
              "type": "array",
              "minItems": 1,
              "maxItems": 8,
              "items": { "$ref": "#/$defs/singleAction" }
            }
          }
        }
      ]
    },
    "observe_after": { "type": "boolean", "default": true },
    "wait": {
      "type": "object",
      "additionalProperties": false,
      "required": ["condition"],
      "properties": {
        "condition": { "enum": ["changed", "stable"] },
        "observation_id": { "type": "string" },
        "stable_ms": { "type": "integer", "minimum": 100, "maximum": 5000, "default": 200 },
        "timeout_ms": { "type": "integer", "minimum": 0, "maximum": 5000, "default": 1000 }
      }
    }
  }
}
```

Recommended `singleAction.type` enum:
`click`, `double_click`, `move`, `mouse_down`, `mouse_up`, `scroll`, `drag` (2–128 path points), `key_press`, `key_down`, `key_up`, `hotkey` (2–6 keys), `type_text` (max 16,384 bytes).

## 4. Idempotent Operation Cache Algorithm

```js
// Deterministic serialization for payload comparison
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}
```

Lookup rules for `(session_id, operation_id)`:
1. Evict expired entries (`now - entry.createdAt > OPERATION_CACHE_TTL_MS`) and enforce `MAX_OPERATION_CACHE_ENTRIES` (e.g., 128).
2. Compute `fingerprint = canonicalStringify(normalizedRequest)`.
3. If `operation_id` exists:
   - If `entry.fingerprint !== fingerprint` → throw `OPERATION_CONFLICT` (`retryable: false`, `side_effect_possible: false`).
   - If `entry.status === 'in_flight'` → await the same promise (or return `SESSION_BUSY`) without executing twice.
   - If `entry.status === 'completed'` → return the cached response with `idempotent_replay: true`.
4. Otherwise insert `{ status: 'in_flight', fingerprint, createdAt }` before dispatching side effects.
5. If dispatch fails **after** sending bytes to the target session, mark `side_effect_possible: true` so the agent inspects a fresh screenshot before taking any further action.

## 5. Structured Error Envelope

```json
{
  "ok": false,
  "error": {
    "code": "HUMAN_PAUSED",
    "message": "Human operator paused Agent control or interacted directly with the target.",
    "retryable": false,
    "side_effect_possible": false,
    "reason": "local_pointer_activity"
  }
}
```

## 6. Recommended Default Guardrail Constants

| Constant | Recommended Value | Purpose |
|---|---|---|
| `MAX_SEQUENCE_ACTIONS` | `8` | Prevents long blind macros without re-observing |
| `MAX_SEQUENCE_DURATION_MS` | `8_000` | Caps total wall time of a single sequence |
| `HELD_INPUT_LEASE_MS` | `15_000` | Auto-releases stuck `key_down` / `mouse_down` |
| `MAX_OPERATION_CACHE_ENTRIES` | `128` | Bounds memory for idempotency store |
| `OPERATION_CACHE_TTL_MS` | `300_000` (5 min) | Deduplicates retries without holding stale history |
| `MAX_OBSERVATION_ENTRIES` | `256` | Bounds frame metadata cache |
| `OBSERVATION_TTL_MS` | `600_000` (10 min) | Expires old screenshots |
| `MAX_WAIT_MS` | `25_000` | Bounded wait compatible with MCP tool timeouts |
| `MAX_ACTION_WAIT_MS` | `5_000` | Keeps post-action `observe_after` snappy |
| `MAX_TEXT_BYTES` | `16_384` | Prevents runaway clipboard / typing payloads |
