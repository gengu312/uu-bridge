# UU Bridge MCP Tool Reference

Reference specification aligned with `uubridge-mcp` (`uubridge-agent/1`) from [gengu312/uu-bridge](https://github.com/gengu312/uu-bridge).

## MCP Client Configuration

Add the local stdio server to Claude Code, Cursor, Codex, or another MCP-compatible client:

```json
{
  "mcpServers": {
    "uubridge": {
      "command": "node",
      "args": ["/absolute/path/to/uu-bridge/agent/mcp-server.mjs"]
    }
  }
}
```

Start the local web controller before invoking tools:

```bash
npm run start:web
```

## Tool Inventory (12 Tools)

| Tool | Read-Only | Required Args | Purpose |
|---|---|---|---|
| `uu_open_panel` | No | *(none)* | Check local controller health; optionally launch local browser (`open_browser: true`). Never returns tokens/secrets. |
| `uu_list_sessions` | Yes | *(none)* | List active remote sessions, resolutions, display lists, authorization, and human-pause state. |
| `uu_get_session` | Yes | *(none)* | Inspect a session or wait up to `25000` ms (`wait_ms`) for video readiness. |
| `uu_screenshot` | Yes | `session_id` | Capture PNG frame + `observation_id`, `generation`, `geometry_epoch`, `image_size`, `source_size`, `region`. Optional `region`, `max_edge` (64–2048, default 1280), `after_frame_id`, `timeout_ms` (0–5000). |
| `uu_action` | No | `session_id`, `operation_id`, `observation_id`, `action` | Execute one action or a 1–8 step `sequence`. Supports `observe_after` (default `true`) and `wait: { condition: "changed" \| "stable", stable_ms, timeout_ms }`. |
| `uu_wait` | Yes | `session_id`, `observation_id`, `condition` | Wait for `changed` or `stable` in the referenced observation region (`stable_ms`: 100–5000, `timeout_ms`: 0–25000). |
| `uu_release_inputs` | No | `session_id` | Release all held keys/mouse buttons and abort any in-flight sequence. |
| `uu_set_control` | No | `session_id`, `enabled` | Toggle Agent input within human-authorized bounds (cannot override `HUMAN_PAUSED` or unauthorized sessions). |
| `uu_clipboard_get` | Yes | `session_id` | Read remote text clipboard (active polling primarily supported on macOS hosts; Windows relies on push updates). |
| `uu_clipboard_set` | No | `session_id`, `operation_id`, `text` | Write UTF-8 text (up to 16,384 chars) to remote clipboard. |
| `uu_select_display` | No | `session_id`, `display_index` | Switch active remote display (`0`–`63`). Releases held inputs and invalidates prior observations. |
| `uu_disconnect` | No | `session_id` | Cleanly disconnect the remote session and release held inputs. |

## Action Types (`uu_action.action`)

### Single Actions
- `click`: `{ type: "click", x, y, button?: "left"|"right"|"middle"|"back"|"forward", modifiers?: ["CTRL"|"ALT"|"SHIFT"|"META"] }`
- `double_click`: `{ type: "double_click", x, y, button?, modifiers? }`
- `move`: `{ type: "move", x, y }`
- `mouse_down` / `mouse_up`: `{ type: "mouse_down"|"mouse_up", x, y, button? }`
- `scroll`: `{ type: "scroll", x, y, direction: "up"|"down"|"left"|"right", ticks?: 1..10 }`
- `drag`: `{ type: "drag", path: [{ x, y }, ...], button?, duration_ms?: 10..30000 }` (2–128 points)
- `key_press` / `key_down` / `key_up`: `{ type: "key_press"|"key_down"|"key_up", key }`
- `hotkey`: `{ type: "hotkey", keys: ["CTRL", "C"] }` (2–6 keys)
- `type_text`: `{ type: "type_text", text }` (1–16,384 chars, supports Unicode/CJK)

### Bounded Sequence
```json
{
  "type": "sequence",
  "interval_ms": 100,
  "actions": [
    { "type": "click", "x": 420, "y": 180 },
    { "type": "hotkey", "keys": ["CTRL", "A"] },
    { "type": "type_text", "text": "hello world" },
    { "type": "key_press", "key": "ENTER" }
  ]
}
```

## Protocol Guardrails & Limits

| Limit | Value |
|---|---|
| Max actions per `sequence` | 8 |
| Max `sequence` duration | 8,000 ms |
| Held input auto-expiry lease | 15,000 ms |
| `operation_id` idempotency cache | 128 entries / 5 min TTL |
| `observation_id` cache | 256 entries / 10 min TTL |
| Max `type_text` / `clipboard_set` payload | 16,384 bytes |
| Max `uu_get_session` / `uu_wait` timeout | 25,000 ms |
| Max `uu_action` post-action wait | 5,000 ms |

## Canonical Key Names

- **Modifiers:** `CTRL`, `ALT`, `SHIFT`, `META` (aliases `CMD`, `COMMAND`, `WIN`, `OPTION`, `CONTROL` are accepted and normalized).
- **Navigation & Editing:** `ENTER` (`RETURN`), `TAB`, `SPACE`, `BACKSPACE` (`BS`), `DELETE` (`DEL`), `ESCAPE` (`ESC`), `UP`, `DOWN`, `LEFT`, `RIGHT`, `HOME`, `END`, `PAGE_UP`, `PAGE_DOWN`, `INSERT`, `CAPS_LOCK`, `PRINT_SCREEN`, `NUM_LOCK`.
- **Alphanumeric & Function:** `A`–`Z`, `0`–`9`, `F1`–`F12`, `NUMPAD0`–`NUMPAD9`, `NUMPAD_ENTER`.
- **Punctuation (US layout):** `COMMA`, `PERIOD`, `MINUS`, `EQUAL`, `BRACKET_LEFT`, `BRACKET_RIGHT`, `BACKSLASH`, `SEMICOLON`, `QUOTE`, `SLASH`, `BACKQUOTE`.
