# Handoff

## Completed This Session

- Fixed the reviewed runtime issues in `server.mjs`, `renderer.js`, and `config.json`.
- Refreshed `README.md` and these Ergon notes to match the current polling-based runtime.
- Verified syntax, config parsing, endpoint behavior, static-file restrictions, malformed-path handling, and request body limiting.

## Current Runtime Shape

- Server binds to `127.0.0.1` by default.
- Browser polls `GET /status`; SSE is not used.
- `POST /expression` updates a revisioned state object; `value` can be a scalar or `[min,max]` range.
- `GET /expressions` returns expression usage notes from matching `.txt` files.
- Static serving is allowlisted to `index.html`, `renderer.js`, and current-theme expression PNGs.
- Existing clipped flash glitches and film-style drift run independently; vertical drift uses main-layer `background-position-y`, horizontal drift uses main-layer `background-position-x`, and neither touches `#div-glitch`.

## Watch Out For

- Port `2747` may already be occupied by a running kiosk process; restart it to pick up code changes.
