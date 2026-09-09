# WebRTC architecture

Status: current implementation and planned direction as of July 2026.

## Scope

`serve-sim` exposes one or more booted Apple simulators to a browser. It owns:

- Simulator discovery and lifecycle commands.
- IOSurface screen capture.
- MJPEG, AVCC/H.264, and WebRTC video delivery.
- HID input, screen metadata, accessibility, DevTools, and simulator tools.

The deployment environment is trusted. Authentication and authorization are
outside this design. Recording is also outside the WebRTC transport: a recorder
should consume captured frames alongside the live transports, not record an RTP
stream or decoded browser output.

## Decisions

1. WebRTC carries video only.
2. The existing helper WebSocket is the canonical input and metadata channel.
3. HTTP video remains available for compatibility, automation, and multiple
   viewers.
4. Multiple WebRTC viewers can share one simulator capture session.
5. SDP offer setup is serialized, but established peer sessions coexist.
6. All transports reuse the same SimulatorKit IOSurface capture session.
7. WebRTC stays opt-in for the bundled preview while its operational behavior is
   being validated on the target macOS VMs.

## Why WebRTC exists

AVCC over HTTP is efficient and low-latency when VideoToolbox can encode H.264.
The hosted macOS VMs may not expose that encoder. MJPEG works there, but consumes
substantially more CPU and bandwidth for a moving native-resolution simulator.

The bundled WebRTC implementation adds software VP8/VP9 encoding and provides:

- Congestion control and bandwidth estimation.
- Receiver jitter buffering and packet-loss recovery.
- Browser-native video decode and presentation.
- Direct, STUN-derived, or TURN-relayed media paths.

For a same-host browser, HTTP can remain as good as or better than WebRTC. The
main WebRTC use case is an interactive simulator viewed across a real network,
especially from a VM without usable H.264 hardware encoding.

An HTTP tunnel carries SDP signaling but does not automatically carry WebRTC
media. Remote deployments that cannot establish a direct candidate pair need a
working TURN server.

## Current architecture

```text
simMiddleware / serve-sim CLI
  |
  +-- preview config: preferred transport, codec, ICE servers
  +-- /helper/<udid>/stream.mjpeg
  +-- /helper/<udid>/stream.avcc
  +-- /helper/<udid>/webrtc/offer + /close
  +-- /helper/<udid>/ws
          |
          v
DeviceSession (one per UDID)
  +-- NativeCapture
  +-- NativeHid
  +-- HTTP stream handlers
  +-- WebRTC signaling handlers
  +-- WebSocket input and screen-config fan-out
          |
          v
CaptureEngine
  +-- FrameCapture (callbacks + IOSurface seed poll -> CVPixelBuffer)
  +-- MJPEG consumers
  +-- AVCC consumers
  +-- WebRTCPublisher consumer
          |
          v
WebRTCPublisher (LiveKit WebRTC framework)
  +-- active peer registry and serialized SDP offer setup
  +-- ICE gathering
  +-- codec preference and H.264 capability probe
  +-- pre-encode resolution scaling and pixel-buffer conversion
  +-- latest-frame pacing at the configured frame rate
```

The browser has three rendering paths:

| Mode | Server endpoint | Browser surface | Control |
| --- | --- | --- | --- |
| MJPEG | `/stream.mjpeg` | `<img>` | WebSocket |
| AVCC | `/stream.avcc` | WebCodecs + `<canvas>` | WebSocket |
| WebRTC | `/webrtc/offer` + RTP | `<video>` | WebSocket |

### Capture and frame flow

`FrameCapture` registers private SimulatorKit screen callbacks on every display
descriptor and chooses the largest live IOSurface. A 60 Hz IOSurface seed poll
catches changes when virtualized SimulatorKit callbacks arrive below the display
cadence, while seed checks avoid duplicating unchanged frames. The poll is not a
capture-rate ceiling: callbacks still deliver prompt unique changes between poll
ticks. Capture also maintains a fixed 5 fps idle floor. Every frame has a host
monotonic capture timestamp.

`CaptureEngine` fans frames out synchronously to consumers. Each encoder keeps a
single newest pending frame, so a slow consumer cannot create latency by
building a backlog. `WebRTCPublisher` retains the newest captured frame and uses
one absolute-cadence pump as the only configured FPS controller. After the first
frame, it continuously resubmits that retained buffer with fresh presentation
timestamps; new captures replace it without building a backlog. The libwebrtc
source adapter uses a 1,000 FPS safety ceiling and RTP senders have no additional
FPS cap, avoiding independently phased frame droppers. The publisher pre-scales
accepted pixel buffers to the configured maximum dimension and only accepts
frames while at least one peer is connected. Its shared video source fans each
submission out to every peer connection; libwebrtc maintains an independent
sender, encoder, bitrate estimate, and packet stream per viewer.

The pump is hardened against hostile host timing, because a production trace
showed it silently degrading to send-on-arrival on a virtualized macOS VM
(forwarded ≈ offered instead of ~60/s):

- Each chain tick is armed as a strict, zero-leeway `DispatchSourceTimer`, which
  opts out of the timer coalescing that stretched `asyncAfter` wake-ups. At most
  one timer is pending at a time, so a replacement chain cannot race a zombie.
- A late tick advances to the next cadence slot but never skips slots; a stall
  longer than an interval re-anchors to the present instead of draining a
  catch-up burst. Consistently late timers therefore cost phase, not rate.
- Arrivals watch chain liveness. If a scheduled pump has not ticked for four
  intervals, the next capture arrival restarts the chain under a fresh
  generation. Restarts are counted and exposed as `pumpRestarts` in
  `/webrtc/stats`; a nonzero value means the host starved or dropped timers.
- The publisher holds a `latencyCritical` `ProcessInfo` activity while it
  exists, so macOS does not apply App Nap-style throttling to the detached
  daemon.

The sender stamps the playout-delay extension as min 0 / max 0 by default:
every frame renders as soon as it arrives. `SERVE_SIM_WEBRTC_PLAYOUT_MAX_MS`
raises the max for a deployment, letting the receiver absorb arrival jitter —
encode-time spikes, transatlantic wobble — instead of rendering it as stutter.
Changing the default is a viewer-visible latency decision and waits on
tap-to-pixel measurements.

The WebRTC publisher is created lazily on the first offer. Its frame consumer
currently remains attached until the device capture session stops, but sending
a frame while no peer is active exits before conversion or encoding.

### Signaling lifecycle

1. The browser creates a receive-only video transceiver and gathers ICE.
2. It POSTs an SDP offer, session ID, codec preference, and ICE configuration.
3. Native creates a peer connection for that session, applies codec preferences,
   gathers ICE, and returns a complete SDP answer.
4. The session joins the active peer registry. The publisher starts accepting
   frames when the first peer reaches `connected`.
5. Browser unmount, codec replacement, timeout, or transport failure POSTs the
   session ID to `/webrtc/close`.
6. Native closes orphaned signaling or unconnected sessions after a deadline
   without affecting other peers.

The publisher negotiates one offer at a time because ICE gathering mutates
delegate state asynchronously. A concurrent offer receives `409` and retries;
an already established viewer does not block a new offer.

Signaling is currently non-trickle. Browser and native each wait up to three
seconds for ICE gathering. This keeps the protocol small but increases startup
time and can miss a slow TURN candidate.

### Failure policy

Codec fallback and transport recovery are distinct:

- A connected peer that exposes a video track but cannot decode its first frame
  advances the codec ladder.
- Signaling, ICE, connection, and track-ending failures retry the same codec with
  bounded exponential backoff.
- A busy response waits for the current offer negotiation to finish. Every retry
  gets a fresh HTTP signaling timeout.
- An explicit signaling rejection is terminal and is shown to the user.

The current codec ladder is H.264 -> VP8 -> VP9 when H.264 was requested, and
VP9 -> VP8 when VP9 was requested. Native can also prefer VP8 when its H.264
runtime probe fails.

## WebSocket control decision

WebRTC data-channel input was removed intentionally. The preview already keeps
the helper WebSocket open because it carries screen size and orientation updates.
Using both channels for HID introduced a handover point where `begin` could be
sent on WebSocket and `move` or `end` on the data channel. Each channel is
ordered independently, but their combined delivery order is undefined.

Keeping WebSocket control gives us:

- One ordered path for every gesture and hardware-button sequence.
- Existing reconnect and bounded queue behavior.
- Screen metadata on the same control connection.
- The same behavior in MJPEG, AVCC, and WebRTC modes.
- No native WebRTC-to-Node callback queue on a libwebrtc thread.

A data channel should only be reconsidered if measured WebSocket latency is a
material problem and WebRTC can replace the entire helper control socket. A
partial migration is not worth the extra lifecycle and ordering complexity.

Every viewer owns a WebSocket, and all sockets have equal control access. Input
is dispatched in arrival order with no exclusive-controller lease. Messages are
ordered within one viewer's socket; operations from different viewers can
interleave, so two people dragging at exactly the same time still contend for
the simulator's single synthetic touch surface.

## Current constraints

- WebRTC capture work is shared, but software encode and outgoing bandwidth grow
  with the number of connected peers.
- There is no configured WebRTC peer limit or cross-viewer control arbitration.
- No automatic fallback from unreachable WebRTC media to HTTP video.
- Codec configuration describes a preference, not the negotiated sender codec.
- Signaling URLs are derived from the MJPEG URL rather than advertised directly.
- Encoder resolution, frame rate, and target bitrate are shared across viewers;
  one viewer changing them affects every peer attached to that simulator.
- There is no process-wide resource budget across several software-encoded
  simulators.
- External `simctl shutdown` is detected by state/grid polling rather than a
  dedicated device lifecycle observer.
- Runtime WebRTC metrics are logs, not a structured status surface.
- The LiveKit framework is linked into the main native addon, so HTTP-only users
  also carry the framework.
- The native publisher combines session state, SDP processing, ICE, codecs,
  frame conversion, and pacing in one file.

These are limitations to plan around, not reasons to replace the current frame
capture or WebRTC media path.

## Target architecture

```text
DeviceRegistry
  |
  +-- DeviceRuntime (one per UDID)
        +-- SimulatorLifecycleMonitor
        +-- InputDispatcher <- WebSocket control
        +-- FrameSource
              |
              v
            FrameHub
              +-- MjpegTransport
              +-- AvccTransport
              +-- WebRtcSessionManager -> NativePeerSession[]
              +-- Recorder (separate feature)

MediaPolicy -> MediaCapabilities -> Browser VideoTransportController
```

### Server responsibilities

`DeviceRuntime` should compose capture, input, metadata, and device lifecycle.
It should not implement transport-specific signaling.

`FrameSource` should only own SimulatorKit capture. `FrameHub` should own latest
frame replay and explicit demand-based subscriptions. HTTP encoders, WebRTC, and
recording should be sibling consumers.

`WebRtcSessionManager` should own the peer registry, serialized signaling
lifecycle, typed close reasons, reconnect generations, and native peer handles.
`DeviceSession` should delegate WebRTC routes to it.

The native boundary should eventually expose typed session operations and state:

```ts
createWebRtcSession(request): Promise<{
  answer: RTCSessionDescriptionInit;
  sessionId: string;
}>;
closeWebRtcSession(sessionId: string): Promise<void>;
onWebRtcState(sessionId, state, details): void;
```

The native implementation can then be split by responsibility without changing
the media hot path:

- Peer/session lifecycle and delegates.
- SDP and ICE helpers.
- Codec capability and selection.
- Frame pacing and pixel-buffer adaptation.

### Client responsibilities

The browser should have one transport-neutral controller with explicit states:

```text
idle -> negotiating -> connecting -> playing
                    -> reconnecting -> playing
                    -> failed
                    -> closed
```

`MjpegTransport`, `AvccTransport`, and `WebRtcTransport` should implement the
same lifecycle contract. `SimulatorView` should render the selected surface and
handle input, but should not infer video ownership from the presence of an input
callback.

A future capability document should expose API version, explicit endpoint URLs,
available transports, runtime codecs, operational WebRTC viewer limits, and
negotiated session details. The browser should prefer WebRTC when configured, retry
transport failures independently from codec failures, and optionally fall back
to HTTP when the network cannot establish WebRTC media.

## Migration plan

### Current hardening

- Keep WebSocket as the sole control path.
- Separate external input from external MJPEG frame routing.
- Restrict codec fallback to connected first-frame decode failures.
- Retry transport failures with the same codec.
- Give every busy-retry offer a full signaling deadline.
- Release established sessions with an unload-safe close beacon.
- Preserve shared capture while giving every WebRTC peer an independent
  lifecycle.

### Next

- Extract browser transport state from the main preview component.
- Extract a TypeScript `WebRtcSessionManager` from `DeviceSession`.
- Report actual negotiated codec and structured connection state.
- Add a proactive simulator shutdown signal that closes every media transport.
- Add a real macOS WebRTC integration test for VP8, two live viewers, and
  independent peer cleanup.

### Later, when required

- Add HTTP fallback after repeated ICE/transport failures.
- Add trickle ICE for faster startup and slow TURN discovery.
- Add resource profiles or a process-wide software-encoding budget.
- Split the native publisher into testable units.
- Consider an SFU or encoded-frame relay if concurrent viewer counts make
  per-peer software encoders too expensive.
- Consider optional WebRTC packaging only if installed size becomes material.

## Validation matrix

The stable transport should be exercised against:

- Same-host direct candidates.
- LAN direct or server-reflexive candidates.
- TURN-only connectivity.
- H.264-capable hosts and VP8-only VMs.
- Browser unmount during signaling.
- Peer failure after decoded video has started.
- Two viewers connecting concurrently, then closing independently.
- Viewers negotiating different codecs against the shared frame source.
- Two simulators software-encoding concurrently.
- External simulator shutdown while multiple viewers are connected.
- HTTP and WebRTC viewers running side by side.

The useful operational signals are negotiated codec, candidate-pair type, RTT,
packet loss, actual bitrate, encoded/sent/dropped frames, encode duration, and
the final close reason.
