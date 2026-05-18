# Clara Avatar Kiosk

Node.js HTTP server plus browser renderer for displaying Clara's avatar expressions on a kiosk display.

## Run

```bash
node server.mjs
```

By default the server listens on `127.0.0.1:2747`. Open `http://127.0.0.1:2747` in the kiosk browser.

## API

### Set Expression

```http
POST /expression
Content-Type: application/json

{ "expression": "happy", "value": 0.7 }
```

- `expression`: name of a `.png` file in `images/expressions/{theme}/`
- `value`: either a scalar number from `0` to `1`, or a two-number range `[min,max]`

Scalar values map to a single frame:

| Value | Meaning |
|-------|---------|
| `0` | first / lowest-intensity frame |
| `0.5` | middle frame |
| `1` | final / highest-intensity frame |

Range values let Clara describe uncertainty or a changing state. The renderer maps both ends to frames, then animates back and forth inside that frame band.

Range example:

```json
{ "expression": "tired", "value": [0.3, 0.7] }
```

This means roughly “between 30% and 70% tired”. Reversed ranges are accepted and normalized by the server.

Response:

```json
{
  "ok": true,
  "expression": "tired",
  "value": [0.3, 0.7],
  "revision": 12
}
```

`revision` is monotonically increased for each accepted expression update.

### Current Status

```http
GET /status
```

Returns the current state. `value` may be either a scalar or a range.

```json
{
  "expression": "tired",
  "value": [0.3, 0.7],
  "revision": 12
}
```

The browser polls this endpoint and ignores stale revisions.

### Available Expressions

```http
GET /expressions
```

Returns a JSON object keyed by expression name. Each value is a direct usage note for Clara from the matching `.txt` file in the current theme's expression directory.

Example shape:

```json
{
  "angry": "Starts as a controlled scowl, builds through tighter brows and clenched anger, and only the highest values become open yelling. Use it for anger at any intensity; reserve high values for shouting-level fury.",
  "tired": "Heavy eyelids and low energy build into fully worn-out exhaustion. Use it for fatigue, depleted attention, late-night softness, or needing rest."
}
```

Clara can use this endpoint to discover the available expression names and decide which expression fits a message before calling `POST /expression`.

### Token Stream

```http
POST /text
Content-Type: application/json

{ "mode": "append", "kind": "chat", "text": "Hello", "title": "ASSISTANT STREAM" }
```

- `mode`: `"replace"`, `"append"`, or `"clear"`. If omitted, text is replaced.
- `kind`: `"chat"`, `"user"`, `"reasoning"`, `"task"`, `"tool"`, or `"status"`.
- `text`: token or full text content.
- `title`: optional stream title shown above the text.

Append tokens:

```json
{ "mode": "append", "kind": "chat", "text": " world" }
```

Replace with structured segments:

```json
{
  "title": "ASSISTANT STREAM",
  "segments": [
    { "kind": "user", "text": "Question\n" },
    { "kind": "chat", "text": "Answer" }
  ]
}
```

Clear the stream:

```http
POST /text/clear
```

Read current stream state:

```http
GET /text
```

The browser receives live token updates from `GET /text/events` and falls back to polling `GET /text` if events disconnect.

When `activityBridgeEnabled` is true, Clara activity events from `assistantActivityUrl` are appended automatically. `chat.user.message` renders as `user`; `llm.token` renders as `chat` or `reasoning` based on its channel; tool and task events render as `tool`, `task`, or `status`.

## Config

`config.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `2747` | HTTP server port |
| `host` | string | `"127.0.0.1"` | Bind host |
| `theme` | string | `"dark"` | Expression image directory |
| `maskColor` | string | `"#000000"` | Page and avatar background color |
| `maxBodyBytes` | number | `65536` | Maximum JSON POST size |
| `controlToken` | string | `""` | Optional bearer or `X-Clara-Avatar-Token` token for `POST /expression` |
| `switchMs` | number | `400` | In-place film-splice expression switch duration |
| `switchTimingFunction` | string | `"ease-in-out"` | CSS timing function for expression switches |
| `switchSplicePixels` | `[min,max]` | `[8,32]` | Vertical misregistration range for in-place expression switches |
| `snapScrollMs` | number | `50` | Per-frame vertical snap duration |
| `snapTimingFunction` | string | `"ease-in-out"` | CSS timing function for frame snaps |
| `snapHoldMs` | number | `120` | Hold between vertical frame snaps |
| `pollIntervalMs` | number | `500` | Browser polling interval |
| `glitchIntervalMs` | `[min,max]` | `[20,60]` | Delay between glitch flashes |
| `glitchDurationMs` | `[min,max]` | `[20,50]` | Glitch flash duration |
| `glitchForceHorizontal` | boolean | `true` | Use horizontal glitch strips |
| `glitchForceVertical` | boolean | `false` | Use vertical glitch strips |
| `glitchDiff` | `[min,max]` | `[20,100]` | Random strip thickness range |
| `glitchRandomEmotion` | boolean | `false` | Pick glitches from any cached expression |
| `driftEnabled` | boolean | `true` | Enable occasional vertical film slip |
| `driftIntervalMs` | `[min,max]` | `[3500,12000]` | Delay between vertical slip events |
| `driftPixels` | `[min,max]` | `[1,4]` | Vertical slip intensity in pixels |
| `driftDurationMs` | `[min,max]` | `[80,180]` | Time to slip vertically out of alignment |
| `driftTimingFunction` | string | `"cubic-bezier(.16, 1, .3, 1)"` | CSS timing function for vertical slip |
| `driftHoldMs` | `[min,max]` | `[40,160]` | Time to hold the vertical offset before returning |
| `driftReturnMs` | `[min,max]` | `[120,280]` | Time to settle vertically back into alignment |
| `driftReturnTimingFunction` | string | `"cubic-bezier(.45, 0, .2, 1)"` | CSS timing function for vertical settling |
| `horizontalDriftEnabled` | boolean | `true` | Enable constant random horizontal film wander |
| `horizontalDriftIntervalMs` | `[min,max]` | `[45,220]` | Delay before picking the next horizontal offset |
| `horizontalDriftPixels` | `[min,max]` | `[1,4]` | Horizontal drift intensity in pixels |
| `horizontalDriftDurationMs` | `[min,max]` | `[20,70]` | Time to move to the next horizontal offset |
| `horizontalDriftTimingFunction` | string | `"cubic-bezier(.2, 0, 0, 1)"` | CSS timing function for horizontal drift |
| `textPollIntervalMs` | number | `500` | Browser fallback polling interval for the token stream |
| `activityBridgeEnabled` | boolean | `true` | Append assistant activity SSE events into the token stream |
| `assistantActivityUrl` | string | `"http://127.0.0.1:3000/api/activity/stream"` | Assistant activity SSE URL used when the bridge is enabled |

If `host` is not loopback, `controlToken` is required.

Numeric timing and intensity values are used directly. Setting a transition duration to `0` makes that phase immediate. Timing-function strings are passed directly into CSS.

## Runtime

- Server validates config at boot and only serves `index.html`, `renderer.js`, bundled Doto fonts, and current-theme expression PNGs.
- Browser polling uses `/status` revisions so late image loads cannot overwrite newer states.
- The page uses the CRT client's two-column display pattern: avatar on the left, token stream on the right.
- Expression changes snap frame-by-frame, then switch in place with a short film-splice opacity/background-position transition. Range values continue snapping back and forth inside the requested frame band, with the range endpoints held for `10x` to `40x` the normal snap hold time.
- A third overlay div renders short clipped glitch flashes from cached images.
- Vertical film drift occasionally offsets the main image divs' `background-position-y`, then returns to center.
- Horizontal film drift independently and repeatedly offsets the main image divs' `background-position-x` to random nearby positions.
