# LLP 0001: Video pipeline and recording

**Type:** Explainer
**Status:** Active
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-09-29
**Revised:** 2026-10-14 (observed device state and recording geometry; recording reboot recovery)
**Related:** LLP 0002, LLP 0003

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

This describes the H.264 WebRTC and session-recording paths. See
[WebRTC architecture](0002-serve-sim-webrtc-architecture.explainer.md) for signaling and control, and
[API](0003-serve-sim-http-api.spec.md) for the recording endpoint. HTTP video remains a separate transport.

## Frame flow

```text
SimulatorKit active-panel IOSurface
  -> CVPixelBuffer view of the surface
  -> one owned snapshot on the capture queue
       native size while recording, else the largest size a consumer needs
       |-> (recording) latest-frame mailbox -> hardware H.264 recorder
       |     -> MP4 + session.json
       `-> viewer resize queue: scale/letterbox to the shared canvas
             -> frame pump -> shared H.264 encoder -> H.264 WebRTC senders
                           `-> per-peer VP8 encoders -> VP8 WebRTC senders
```

`FrameCapture` follows CoreDevice's authoritative active display on a foldable
simulator. It combines SimulatorKit callbacks with a 60 Hz IOSurface seed poll;
that poll is a fallback cadence, not a ceiling on callback-driven changes. Seed
checks avoid copying unchanged pixels except for the capture idle floor. A
`CVPixelBuffer` initially wraps the IOSurface without copying it. The capture
queue then makes an owned snapshot so encoders can retain a frame after the
simulator reuses the surface.

The snapshot size follows the consumers (`CaptureSnapshotPolicy`): native
while recording, the configured capture size while an MJPEG or AVCC subscriber
is active, otherwise the shared H.264 canvas, so viewer frames need no further
scaling. Starting recording changes it to native size and publishes the latest
owned buffer to a one-slot mailbox. WebRTC, HTTP consumers, the recording clock, and
disk work do not run on the capture queue. A slow consumer replaces or drops
pending work instead of accumulating a frame backlog. Stopping recording
returns to the size selected by the remaining consumers: the configured
capture size for MJPEG or AVCC subscribers, or the shared canvas for
WebRTC-only viewers.

The normal snapshot uses VideoToolbox pixel transfer into a pooled buffer. An
odd-size BGRA panel uses a Metal-backed Core Image copy into an even-size
buffer, preserving the right and bottom pixels. A failed normal transfer can
fall back to a CPU copy, and capture reports that count; the expected
recording-plus-WebRTC path uses the accelerated transfer. Neither a
`CVPixelBuffer` wrapper nor a GPU transfer guarantees that the simulator is
never delayed by a surface fence. Direct copy and viewer-scale latencies still
need separate measurements.

## Capture recovery

Callback changes re-rank cached surfaces. Capture reads each descriptor's live
surface, including the masked-surface fallback, once per second independently
of those callbacks. Wiring a new descriptor set performs an initial live read.
A surface that changes without a callback is discovered at the next live read.
Replacing or dropping a cached surface clears its seed and canvas caches, so a
replacement with the same seed still reaches capture. [observed:
`Sources/SimNative/FrameCapture.swift`, `currentSurface()`, `updateCachedSurface(_:for:)`]

Before the first frame, capture retries framebuffer wiring once per second.
Afterward, a live read confirming at least one second without a selected surface
starts recovery; retries continue once per second until a surface returns.
While the simulator is not booted, capture makes neither the live read nor the
retry; the loss still counts, and both resume at the next once-per-second check
after it boots.
Cached misses between live reads do not advance recovery. Unchanged pixels on
a static screen do not trigger recovery while its surface is available.
Capture logs the start and end of a loss. [observed: `Sources/SimNative/FrameCapture.swift`;
`Sources/StreamingPolicy/FramebufferSurfaceWatch.swift`]

`/webrtc/stats` reports `surfaceLosses`, cumulative `surfaceLostMs`
(in milliseconds, including an ongoing loss), and `rewires` under `capture`. Loss counters cover
losses after the first frame; rewires count attempts, including startup retries.
These counters reset when capture starts. [observed:
`Sources/StreamingPolicy/FramebufferSurfaceWatch.swift`;
`Sources/SimNative/CaptureEngine.swift`]

## WebRTC viewers

`ViewerFrameResizer` places each captured frame on the shared viewer canvas
on its own queue, so the frame pump never waits on a resize. The default
backend scales the Y and CbCr planes on the GPU with Metal Performance Shaders
(bilinear) into a bounded pool; a frame that already matches the canvas passes
through. The VideoToolbox transfer is the fallback, with its own vImage CPU
path. A frame that arrives while one is in flight replaces the waiting frame.
`SERVE_SIM_VIEWER_RESIZE=metal|videotoolbox|cpu` selects a measurement
backend. Metal retains the VideoToolbox fallback; the other two modes use
only the selected backend.

`WebRTCPublisher` paces the latest resized frame with a token bucket. A fresh
frame goes out when it arrives while a token is left. Tokens refill at 1.5
times the configured viewer rate, so a burst of frames after a late capture copy
goes out whole instead of the newest replacing the middle one. The previous
frame repeats at the configured rate: one interval after the last send on an
idle screen, and 1.5 intervals after it while the source is active, so a late
fresh frame keeps its token. The simulator rewrites its surface without new
content, 70 to 120 times a second against 60 app frames on EAS. A resized frame
with the same pixels as the retained frame (every pixel byte of both planes)
replaces it but does not count as fresh for the pump, so a rewrite does not take
the slot of the next real frame. It still lets the pump restart a chain that
stopped ticking. A frame from before a canvas change is dropped at the pump
rather than encoded at the wrong size. Resized frames from an earlier viewer
session are discarded after the viewer acceptance generation changes. A custom
H.264 encoder factory gives each H.264 peer a proxy over one
`VTCompressionSession`.
Proxies deduplicate submissions by frame timestamp and distribute the one
compressed result to the peers. The shared target bitrate is the minimum of
active peers' requests; a join or PLI requests an IDR. `DataRateLimits` hold the
shared encoder to that target over one second and to 1.5 times it over a tenth
of a second. With `AverageBitRate` alone, the first frames of a full-screen
change ran to two or three times the target, and libwebrtc answered by dropping
frames before encode. Each peer still owns its connection, congestion
controller, and RTP packet stream.
If a peer misses a shared delta frame, it waits for the next shared IDR;
recovery does not replay frames or start another encoder.

All viewers use the shared input canvas. H.264 viewers share one encode;
VP8 viewers encode separately from that same canvas. With no H.264 viewer, the
canvas has no H.264 level limit. In a mixed session, VP8 shares the H.264
canvas, including its letterboxing and resolution limit.
`SharedResolutionPolicy` steps the canvas long edge to 0.75 and then 0.5 when
the lowest H.264 peer bitrate stays under 40% of the target for 2 s, and steps back
up after 10 s above 90%. It holds still for 5 s after a peer joins and for
10 s after a step, because libwebrtc restarts the encoder proxies when the
frame size changes. A step requests an IDR and changes the capture snapshot
size. The canvas also follows changes in the active simulator display geometry.
H.264 peers keep `maintainResolution`, so libwebrtc adapts their bitrate and
frame rate only. VP8 peers use `balanced` and may downscale their own output.
One constrained H.264 viewer lowers the shared canvas for every viewer.
`/webrtc/stats` reports the canvas, scale, and step count under `sharedCanvas`,
the resize counters under `viewerResize`, and the pump deferrals, repeats,
unchanged frames, and canvas-mismatch drops under `capture`. `capture` also
has cumulative pump timer ticks with their total and largest lateness, and the
count, total, and largest time of the synchronous submit to libwebrtc, so two
samples give the averages over the window between them.

Viewer size, rate, bitrate, and negotiated H.264 level affect the live stream,
not the recording. If the H.264 canvas is not ready or an offered H.264 level cannot decode
it, a viewer offering VP8 uses the existing per-peer software path. An H.264-only
viewer can join at a lower level by shrinking the shared canvas to fit.
The same VP8 path remains when the H.264 hardware probe fails. The recording
encoder is independent of those fallbacks.

## Session recording

`NativeVideoRecorder` owns a separate VideoToolbox H.264 compression session.
It requires and checks hardware acceleration on the actual session; failure
stops recording rather than silently choosing software encoding. Hardware
H.264 encoding is a video-encoder operation, not necessarily a GPU shader.
The encoder identity and frame counts are reported when recording finishes.

The recorder's fixed canvas takes the maximum width and height across the
simulator's native panels, rounded up to even dimensions. The active panel is
placed on that canvas during fold and unfold; the file dimensions do not
change. If the owned snapshot already matches the canvas, it goes directly to
the encoder. Otherwise VideoToolbox pixel transfer letterboxes it. The
recording path has no CPU scaling fallback.

A monotonic 60 Hz timer submits the latest safe snapshot and repeats it when
the simulator has no new image. Thus 60 output samples per second is a target,
not a promise of 60 distinct rendered frames. The recorder bounds pending
frames, pixel buffers, and writer work, and counts coalesced ticks, drops,
repeats, backpressure, and encode time. Overloaded hosts can miss the target.

### Keyframe contract

The recording encoder sets `kVTCompressionPropertyKey_MaxKeyFrameInterval`
to 60 submitted frames and `kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration`
to 1.0 second of presentation time. A source pause can leave a larger gap
between recorded keyframes; the first resumed sample is a keyframe
[observed: `Sources/SimNative/NativeVideoRecorder.swift` compression-session
configuration; `Tests/SimNativeTests/NativeVideoRecorderKeyframeTests.swift`].
The continuous-output test checks keyframe PTS gaps at most `1.0 + 1.5 / 60`
seconds, allowing encoder timing tolerance. The pause test requires the first
sample after a gap longer than one second to be a keyframe [observed:
`NativeVideoRecorderKeyframeTests.testKeyframesAreAtMostOneSecondApart` and
`testFirstSampleAfterAPauseLongerThanASecondIsAKeyframe`]. Shorter keyframe
intervals can reduce decoding work when seeking; they do not determine seek
precision [observed: [HTML seeking algorithm](https://html.spec.whatwg.org/multipage/media.html#seeking)].

### Output files

Compressed H.264 samples go to `AVAssetWriterInput` with `outputSettings: nil`,
so the MP4 writer does not encode again. On successful finalization the output
directory contains `recording.mp4` and `session.json`. The manifest keeps the
record-sim upload contract: `firstFrameWallClock` with `unixMs` and `iso8601`,
`width`, `height`, and `recording`.

### Device-state metadata

An optional `deviceStates` timeline describes the recorded device:

```json
{
  "deviceStates": [
    {
      "timeMs": 0,
      "state": { "width": 2007, "height": 2853, "orientation": "landscape_left", "screen": "inner", "contentRect": { "x": 0, "y": 0, "width": 2007, "height": 2853 }, "hingeAngle": 180, "physicalOrientation": "portrait", "tableMode": false }
    },
    {
      "timeMs": 2400,
      "state": { "width": 1398, "height": 2034, "orientation": "landscape_left", "screen": "outer", "contentRect": { "x": 24, "y": 0, "width": 1960, "height": 2854 }, "hingeAngle": 80, "physicalOrientation": "facedown", "tableMode": true }
    }
  ]
}
```

Each event is the full known device state of a submitted video frame, committed
to the timeline only after that frame is successfully appended to the MP4.
The first event has `timeMs: 0`; subsequent times use the video's presentation
clock relative to its first frame. Unchanged states are omitted. Geometry
changes (`screen`, `width`, `height`, `orientation`, and `contentRect`) keep the
timestamp of their first written frame. Pose-only changes are coalesced with
250 ms between normal updates. On stop, the final written state is retained;
coalescing cannot move an earlier geometry boundary. A clip shorter than
250 ms retains both its initial and final state when they differ. Every
timestamp identifies an actual written frame.
An event's `width` and `height` describe the active source panel; the manifest's
top-level dimensions describe the fixed recording canvas. `contentRect` gives
the source picture's bounds in encoded pixels, measured from the canvas's top
left. It excludes letterbox borders and whole pixels added for even dimensions.
The encoder preparation supplies this rectangle with the submitted frame;
metadata is never committed for an unwritten frame.

`orientation` comes from native screen metadata and uses `portrait`,
`portrait_upside_down`, `landscape_left`, or `landscape_right`. On Duo,
`hingeAngle` is in degrees from 0 (closed) to 180 (open). `screen` is `inner` or
`outer`, derived from the captured integrated display's DeviceKit identity in a
two-panel profile. Ordinary devices, external displays, and unknown or
contradictory identities omit it. Recording metadata identifies panels only by
`screen`; numeric screen IDs stay in live capture and input routing. Decoders
ignore unknown keys such as a numeric `screenId` and accept manifests without
semantic screen names or content rectangles.
`physicalOrientation` describes the device pose,
using `portrait`, `pud`, `landscape-left`, `landscape-right`, `faceup`, or
`facedown`; `tableMode` describes observed tabletop activity. Apple's native
tabletop pose value zero (`Ambiguous`) records `false`; recognized values 1–10
record `true`. Missing, malformed, or unrecognized values are omitted. This
Boolean does not report whether the Table Mode control was enabled. Screen
orientation and physical orientation can differ when an app locks its interface.

Unknown fields are omitted rather than inferred. Recording and live previews
share one native observer per device. It keeps a hinge stream configured for
100 ms updates and a one-degree change threshold, plus a generic motion stream
for physical orientation and tabletop activity. The generic stream has no
interval setting. Recording consumes only these observations, independently of
the successful-command cache. Ordinary iPhones omit Duo fields.

Native sample timestamps reject history from before the current native connection
and out-of-order observations. Angle, motion, and orientation-query timestamps
have separate watermarks. A fresh orientation query initializes a stationary
device while the motion stream buffers updates; historical tabletop snapshots
remain unknown until a fresh native event arrives. Treat each saved event as a
complete snapshot: absent optional fields are unknown. See
[confirmed hinge state](0004-serve-sim-hinge-controls.explainer.md#confirmed-hinge-state)
for command and observation lifetimes. External pose changes at an unchanged
angle update the same observer. The native update interval is a request, not a strict
callback throttle; the saved timeline limits pose-only changes to four per second.
If the stream fails, observed fields clear, the observer logs the failure, and
it retries after one second while a recording or live-preview listener remains.
Live notifications keep one dispatch in flight and replace a waiting snapshot
with the latest full state. They use a separate queue from video callbacks, so
video backpressure cannot discard the final pose update.

[observed: `Sources/SimNative/FrameCapture.swift`,
`Sources/SimNative/NativeFrameMailbox.swift`, `Sources/SimNative/CaptureEngine.swift`,
`Sources/SimNative/NativeVideoRecorder.swift`, `Sources/SimNative/PixelBufferLetterboxer.swift`,
`Sources/SimNative/CoreDeviceState.swift`, `Sources/SimNative/CoreDeviceStateReadback.swift`,
`Sources/SimNative/DeviceStateDelivery.swift`, `Sources/SimNative/sim-module.swift`;
`Sources/StreamingPolicy/RecordingManifest.swift`,
`Sources/StreamingPolicy/RecordingDeviceStateTimeline.swift`,
`Sources/StreamingPolicy/SimulatorDisplayProfile.swift`;
`Tests/SimNativeTests/RecordingContentRectTests.swift`,
`Tests/SimNativeTests/DeviceStateSubscriptionTests.swift`,
`Tests/StreamingPolicyTests/RecordingDeviceStateTimelineTests.swift`]

### Saved MP4 layout contract

The writer sets `AVAssetWriter.shouldOptimizeForNetworkUse` to `true`. In the
finalized `recording.mp4`, the `moov` index precedes the `mdat` media data, so
progressive loading can read track metadata before the media payload. The writer
still receives compressed H.264 samples with `outputSettings: nil`; this layout
setting does not alter the recording encoder's bitrate, cadence, or keyframe
configuration [observed: `Sources/SimNative/NativeVideoRecorder.swift`,
`openWriter` and compression-session configuration].

`NativeVideoRecorderTests.testHardwareRecordingRepeatsOwnedFrameAndWritesNativeCanvas`
parses the finalized file's top-level boxes and requires `moov` before `mdat`.
It also checks the native canvas, track frame rate, and duration [observed:
`Tests/SimNativeTests/NativeVideoRecorderTests.swift`]. This is a saved-file
contract; it does not establish fewer capture or browser playback drops.

Fast-start adds work during `finishWriting` that grows with the saved file. On an
M5 Pro with internal SSD and passthrough H.264, Szymon measured about 2.7 seconds
for 2 GB and 6 seconds for 8 GB, compared with 0.01–0.04 seconds without the flag
[confirmed: Szymon (`szdziedzic`), 2026-10-08,
[PR #251 review](https://github.com/expo/expo-device-hub/pull/251#discussion_r4221158869)].

The recorder's 60-second deadline covers encoder flushing. After MP4 writer
finalization starts, that deadline cannot call `cancelWriting`; the recorder
awaits the writer's completion callback. `finalizeMs` measures elapsed monotonic
time from starting writer finalization to its callback, excluding encoder flush
and manifest writing, and appears in the completion log [observed:
`Sources/SimNative/NativeVideoRecorder.swift`, `finish` and `finishOnQueue`;
`Sources/SimNative/CaptureEngine.swift`, `stopRecording`].

This recorder deadline is separate from the CLI's existing 65-second wait for a
helper with a known active recording. If that outer wait expires, the CLI can
still force-kill the helper and interrupt its writer [observed:
`src/stop-process.ts`, `recordingShutdownGraceMs` and `stopProcess`].

After replacing HID on reboot, the session repeats hinge capability discovery and
hydration before admitting input, reading fresh native state even after this session
controlled the hinge. Native getter fallbacks can still report unsupported or
unknown hinge state; completion does not guarantee successful hinge readback
[observed: `src/native.ts`, `NativeHid.guard` and `hingeState`].
An unknown angle does not erase the saved hinge state; resetting old-boot control
ownership permits the next command to retry native seeding and restore matching
saved state [observed: `src/device-session.ts`, `resumeAfterReboot`,
`hydrateHingeState`, and `queueHingeControl`].
A completed native command whose old-boot result was discarded must not leave
stale cached state. Reset old-boot rotation intent before admitting input, so
late discovery preserves a rotation already accepted on the new boot. Old-boot discovery and reads are generation-fenced; cancellation of a
startup read must not permanently hide supported controls [observed: `src/device-session.ts`,
`discoverHingeCapabilities`, `hydrateHingeState`, and `resumeAfterReboot`].

The reboot also pauses the WebRTC pump and clears its retained frame without
closing peer sessions. Sender stats expose `capture.rebooting`; the preview
first-frame and playback watchdogs defer their verdicts during this intentional
pause. Acceptance generations reject old resize completions,
and capture generations reject queued old-boot frames. Only fresh resumed
capture can restart delivery. New recording starts are rejected while capture
is suspended, while existing recording stop and lease renewal remain available.
A start refused before writer creation is an expected cancellation during shutdown
[observed: `CaptureEngine.swift`, `WebRTCPublisher.swift`, and `src/device-session.ts`].

## Control and shutdown

Preview shutdown stops the foreground-app log trackers before waiting for recording
finalization. Pending restarts are cancelled, and subscriptions arriving during
shutdown cannot start another tail. Exit cleanup repeats this stop as a fallback
[observed: `src/foreground-tracker.ts`, `createForegroundTrackerCache`; `src/index.ts`,
`serve` shutdown and exit handlers].

The in-process preview server reports a recording-shutdown error after 65 seconds,
including its PID. It keeps the writer, output and existing device state alive;
it does not exit or tear down capture while recording finalization is pending.
If finalization later completes, ordinary cleanup runs and the process exits with
status 1 because the deadline expired. If it never completes, the process stays
alive for recovery; this deadline reports the stall rather than cancelling the
writer. The parent/helper force-kill policy above is separate [observed:
`src/shutdown-budget.ts`, `runRecordingShutdown`; `src/index.ts`, `serve` shutdown].
Once the in-process server installs its recording-aware signal handler, the
earlier startup handler defers cleanup to it through an explicit ownership flag,
so capture and capabilities stay active until recording finalization completes.
Before that handler is installed, startup owns capture teardown and device
disarming; a capture reaper or an unrelated signal listener cannot take that
ownership [observed: `src/index.ts`,
foreground startup and `serve` signal handlers].

Start serve-sim for the device, then run:

```sh
serve-sim record-video --udid <udid> --output <empty-dir>
# Send SIGINT to stop; the command exits after session.json is available.
```

The CLI owns a recording lease and renews it while running. A client with a
different recording ID cannot stop that recording. When the session uses
`--require-token`, the CLI sends its bearer token for recording control. An
ungated session needs no token. Serve-sim attempts to finalize an active recording
on SIGTERM, SIGINT, or SIGHUP before the process exits. The CLI also waits for
the manifest when the server stops during recording, including when a heartbeat
loses its connection before the CLI receives a stop signal. A saved manifest
without a requested stop is accepted only after the server exits; a lost lease
while the server stays alive remains an error. A definitively lost lease first stops
renewals and attempts an owned DELETE, so renewals cannot prevent finalization
while the CLI waits for the manifest [observed: `src/index.ts`, `recordVideo`]. If a
start request times out, the CLI cancels that recording ID so a late server
start cannot leave an active recording. A finalization failure makes shutdown
exit unsuccessfully after teardown. After an encoder or frame-transfer failure,
the recorder tries to finalize any frames already written. If the writer completes,
the error includes the path to a playable partial `recording.mp4`. No success
manifest is written. Encoder or frame-transfer errors keep recording startup
blocked until serve-sim restarts, except for the completed flush failure
explicitly described under [Recording stall recovery](#recording-stall-recovery).
The foreground CLI gives a helper with a known active recording up to 65 seconds
to finalize after SIGTERM. Without a known active recording, it force-kills an
unresponsive helper after 500 ms. A stream-settings change uses the same
recording-aware wait before replacing the helper and reports a finalization
error while still starting the replacement.

### Recording reboot recovery

The live shared H.264 encoder also drops pending completions and cached packets
on suspension. A private capture-epoch attachment on each source pixel buffer
rejects old frames that libwebrtc hands to the encoder after resume, even when
libwebrtc translates timestamps or rewraps the native buffer. The in-flight encode slot drains
before new work starts, and resumed delivery requests an IDR [observed:
`Sources/SimNative/SharedWebRTCEncoder.swift`, `WebRTCPublisher.swift`].

A capture reboot suspends boot-bound capture and disconnects input instead of
closing `DeviceSession`. It waits for an in-flight recording start to settle;
a rejected recording POST reports its own error without preventing reboot or
leaving input suspended [observed: `src/device-session.ts`, `suspendForReboot`]. The recording lease, MP4 writer, fixed canvas, hardware
H.264 session, and monotonic recording clock survive. Capture stops and the
mailbox is cleared before shutdown. After `bootDevice` awaits successful
`simctl bootstatus -b`, capture is started again; recording takes only new
snapshots, and recovery waits up to 30 seconds for one through an independent
readiness mailbox, so stopping the recording cannot clear the readiness signal. HID is recreated after
capture resets boot-bound CoreDevice state. This avoids reusing the old boot's
input connection. Suspension rejects queued hinge/rotation commands and waits
for all accepted socket messages through native completion before shutting down,
including messages whose client has already disconnected. Server-owned clipboard
input follows the same admission and cleanup rule; Copy is refused while suspended
and accepted in-flight chords drain before capture stops. Pending software-keyboard
probes are invalidated and drained with native toggles before shutdown; the new
boot resets the hidden-keyboard cache before admitting input. The replacement HID
receives the current panel selection even if its ID is unchanged; input admission
resumes only after routing completes [observed: `src/capture/reboot.ts`, `src/device-session.ts`,
`Sources/SimNative/CaptureEngine.swift`].

No samples are submitted while the mailbox is empty. The first resumed sample
requests an IDR, timestamps retain elapsed monotonic time including the reboot
gap, and finalization still occurs on explicit stop, lease expiry, or process
shutdown. `session.json` optionally records `interruptions` with reason
`simulatorReboot`, pause and first appended resume offsets in seconds relative
to the first written sample; an interruption without resumed footage has no
resume offset [observed: `NativeVideoRecorder.swift`, `RecordingManifest.swift`].

Changed source dimensions are hardware-letterboxed onto the original fixed
canvas. The recording codec remains H.264 even when the viewer changes codec;
its encoder and format are not recreated by reboot. Thus these changes do not
require a second MP4 or a new sample description [observed:
`NativeVideoRecorder.swift`, `PixelBufferLetterboxer.swift`]. If boot or fresh
capture fails, the reboot request reports failure and the recording remains
paused, available for explicit finalization or another reboot attempt. If
hardware transfer or encoding cannot continue, existing finalization preserves
a playable partial MP4 where possible and reports an error with its path;
there is no success manifest or silent replacement. Process replacement cannot
append to an already finalized MP4; callers must preserve that artifact and
start a separate recording if they require further footage [observed:
`NativeVideoRecorder.swift`, `src/stop-process.ts`].

### Recording stall recovery

The client sends one owned heartbeat at a time, every five seconds when none is
pending, with a 120-second request timeout. The server lease lasts 180 seconds.
A transport error or server 5xx response does not establish loss of ownership;
the client retries while its host process remains alive. Request-timeout and rate-limit responses also retry. A definitive 4xx
response, host exit, or explicit stop ends the recording. A definitive response
ends the lease as soon as its status arrives, even if its body stalls or fails.
Stop aborts the pending
heartbeat and uses the existing owned finalization path. A crashed client can
therefore retain its recording resources for up to three minutes. An ambiguous
owned DELETE waits up to 300 seconds for its manifest: the full 180-second
lease plus the existing 120-second finalization allowance. Confirmed server
errors still fail immediately. These budgets share pure constants so lease
and CLI reconciliation cannot drift. Workers must cover this longer wait
before deploying the longer lease [observed:
`src/index.ts`, `recordVideo`; `src/device-session.ts`, `refreshRecordingLease`;
`src/recording-timeouts.ts`].

If writer finalization completes after an encoder error, the playable MP4 gets
an atomic manifest with `status: failed` and `error`; the native operation still
throws its original error. The CLI also rejects a failed manifest when it
reconciles host exit or a lost stop response; a saved partial file does not
turn a native failure into success [observed: `src/index.ts`, `recordVideo`].
If failed-manifest publication also fails, that
secondary error is retained as the underlying error; the original native error
code still controls whether recording reuse is safe. A returned encoder-flush error permits a fresh
compression session only after the old session was invalidated. A flush timeout
or transfer/encode error still blocks reuse when native work may be outstanding. Earlier recording failures remain visible at
shutdown even after a later segment succeeds
[observed: `NativeVideoRecorder.swift`, `finishOnQueue`, `writeManifest`;
`CaptureEngine.swift`, `RecordingAvailability`].

The build-tools follow-up preserves an early finalized file and starts a new
recording while the EAS session is live. This is a fallback because the original
writer has already finalized; it cannot be appended safely. Artifacts retain
first-frame wall-clock timestamps and carry `logicalRecordingId` and
`segmentIndex` to identify ordered segments of one recording. A failed fallback
is reported explicitly instead of treating the saved prefix as full-session
success. This requires a separate build-tools deployment; local serve-sim
validation alone does not establish worker behavior [observed: isolated
build-tools `IosSimulatorRecordingUtils.ts`, `deviceRunSessionScreenRecordings.ts`].

## Performance and validation

With recording and N H.264 viewers, the intended cost is one framebuffer
capture, one shared viewer encode, and one full-resolution recording encode.
The former record-sim path took a second framebuffer capture and CPU-locked
copy. It also encoded independently of the WebRTC peers. For one viewer,
encoder count remains two; for two or more viewers, sharing removes the extra
per-viewer H.264 encodes. The second recording encode preserves native size
and cadence when viewer bitrate, resolution, or transport changes.

`viewerResize` reports scale latency.
