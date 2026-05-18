# Clara Avatar Kiosk — Scratchpad

## Conventions

- API scalar values are `0` to `1`, mapped to frame index `0` through `8`; `value` may also be `[min,max]` to animate within a band.
- POST endpoint: `/expression`, payload `{ "expression": string, "value": number | [number, number] }`.
- GET endpoint: `/status`; the browser polls this and ignores stale revisions.
- GET endpoint: `/expressions`; returns `{ expressionName: usageNote }` from matching expression `.txt` files. Notes are direct guidance for Clara, not third-person descriptions.
- Expression images are vertical PNG stacks in `images/expressions/{theme}/`.
- Frame size is fixed at `420x420`; frame count is fixed at `9`.

## Runtime Notes

- The server is vanilla Node.js stdlib and reads `config.json` once at boot.
- Config is validated at boot and defaults are provided in `server.mjs`.
- Numeric timing, intensity, and CSS timing-function config values are used directly; no visual caps or timing-function allowlists are imposed.
- Default bind is `127.0.0.1:2747`.
- If `host` is not loopback, `controlToken` is required.
- Static serving is intentionally allowlisted to the kiosk app and current-theme expression PNGs.
- `images/emotional-grids/` is legacy data and is not served by the app.

## Renderer Notes

- No canvas and no framework.
- Two `.frame-div` elements form the expression double buffer.
- A third `#div-glitch` overlay flashes clipped slices from cached expression images.
- Vertical film drift occasionally offsets the two main image divs' `background-position-y`, then returns to center.
- Horizontal film drift independently and repeatedly offsets the two main image divs' `background-position-x` to random nearby positions.
- `#div-glitch` keeps its original direct `background-position-y`, `clip-path`, and opacity behavior.
- Config exposes timing functions separately for snap, switch, vertical drift-out, vertical drift-return, and horizontal drift transitions.
- Expression changes snap vertically frame-by-frame, switch in place with a short film-splice opacity/background-position transition, then snap up to the target frame.
- Range values keep the same expression active and bounce frame-by-frame inside the requested mapped frame band.
- Range endpoints hold for a randomized `10x` to `40x` of `snapHoldMs`; intermediate frames keep the normal snap hold.
- Last requested state wins during animation via a single pending update.
- Server status revisions prevent late image preloads from applying stale states.
