# Gestures reference

## Contents

- Coordinate system
- Single-touch JSON shape
- Multi-touch JSON shape
- Edge values (system edge gestures)
- Common recipes (swipe, drag, pinch)
- Why `tap` is preferred over `gesture` for taps

## Coordinate system

All coordinates are normalized floats in `[0, 1]`:

- `(0.0, 0.0)` = top-left of the display
- `(1.0, 1.0)` = bottom-right of the display
- `(0.5, 0.5)` = center

The serve-sim client compensates for device orientation automatically. After a `rotate landscape_left`, coords still describe the **logical** display from the user's perspective — you do not rotate them manually.

To convert pixel coords to normalized, discover `streamUrl` with `serve-sim --list -q`, replace its `/stream.mjpeg` suffix with `/config`, and divide by the returned `{width, height}`.

## Single-touch JSON shape

```json
{
  "type": "begin",
  "x": 0.5,
  "y": 0.5,
  "edge": 0
}
```

| Field  | Type    | Required | Values                       |
| ------ | ------- | -------- | ---------------------------- |
| `type` | string  | yes      | `"begin"`, `"move"`, `"end"` |
| `x`    | number  | yes      | `0.0`–`1.0`                  |
| `y`    | number  | yes      | `0.0`–`1.0`                  |
| `edge` | integer | no       | `0`–`4` (see below)          |

A complete touch is a sequence of `begin` → 0 or more `move` → `end` on the **same** WebSocket. Pass an array of 2–256 events to one `gesture` call; separate calls disconnect and release their touches.

Array events may include an integer `delayMs` from 0 to 1000, applied before that event. The default is 0 before the first event and 40 ms before later events. Total delay, including defaults, must not exceed 30 seconds. The command waits for input completion before returning success.

## Multi-touch JSON shape

```json
{
  "type": "begin",
  "x1": 0.4,
  "y1": 0.5,
  "x2": 0.6,
  "y2": 0.5
}
```

| Field      | Type   | Required | Values                       |
| ---------- | ------ | -------- | ---------------------------- |
| `type`     | string | yes      | `"begin"`, `"move"`, `"end"` |
| `x1`, `y1` | number | yes      | first finger, `0.0`–`1.0`    |
| `x2`, `y2` | number | yes      | second finger, `0.0`–`1.0`   |

Multi-touch uses WebSocket opcode `0x05` and does not support `edge`. The CLI event array supports single-touch coordinates only.

## Edge values

The `edge` field flags a touch as a system edge gesture. iOS interprets edge touches specially (e.g., bottom edge swipe = swipe-to-home on Face ID devices). Values:

| Value | Edge   | Effect                                               |
| ----- | ------ | ---------------------------------------------------- |
| `0`   | none   | Regular touch (default; omit `edge` entirely)        |
| `1`   | left   | Left-edge swipe (back gesture in many apps)          |
| `2`   | top    | Top-edge pull (Notification Center / Control Center) |
| `3`   | bottom | Bottom-edge swipe (swipe-to-home on Face ID devices) |
| `4`   | right  | Right-edge swipe                                     |

For a swipe-to-home on a Face ID device, you can use `npx @expo/serve-sim button swipe_home` — it issues the correct edge-3 touch sequence for you.

## Common recipes

### Tap (avoid `gesture` — use `tap`)

```sh
npx @expo/serve-sim tap 0.5 0.5
```

`tap` keeps both touch phases on one connection. Separate `gesture` calls cannot form a complete tap.

### Drag (vertical scroll down)

Send the full sequence in one call, using normalized coordinates:

```sh
npx @expo/serve-sim gesture '[
  {"type":"begin","x":0.5,"y":0.2},
  {"type":"move","x":0.5,"y":0.5},
  {"type":"move","x":0.5,"y":0.8},
  {"type":"end","x":0.5,"y":0.8}
]'
```

The `gesture` host action takes the same array in `{udid, events}`.

### Pinch to zoom in

Send `begin`, `move`, and `end` multi-touch frames on one WebSocket, moving the two fingers apart. Use opcode `0x05` with the shape above; see `references/endpoints.md`. The CLI `gesture` command does not send multi-touch frames.

### Pull down Notification Center (top edge)

```sh
npx @expo/serve-sim gesture '[
  {"type":"begin","x":0.5,"y":0.02,"edge":2},
  {"type":"move","x":0.5,"y":0.4,"edge":2},
  {"type":"end","x":0.5,"y":0.4,"edge":2}
]'
```

### Swipe back from left edge

```sh
npx @expo/serve-sim gesture '[
  {"type":"begin","x":0.01,"y":0.5,"edge":1},
  {"type":"move","x":0.5,"y":0.5,"edge":1},
  {"type":"end","x":0.5,"y":0.5,"edge":1}
]'
```

## Why `tap` is preferred

Use `tap` for a single tap without constructing an event array. Use a complete `gesture` array when you need moves, edge flags, or custom timing. Both commands wait for input completion; this confirms helper processing, not the app's response.
