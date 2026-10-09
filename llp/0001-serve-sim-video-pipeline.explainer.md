# LLP 0001: Video pipeline and recording

**Type:** Explainer
**Status:** Active
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-09-29
**Revised:** 2026-10-08
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

## Control and shutdown

The in-process preview server reports a recording-shutdown error after 65 seconds,
including its PID. It keeps the writer, output and existing device state alive;
it does not exit or tear down capture while recording finalization is pending.
If finalization later completes, ordinary cleanup runs and the process exits with
status 1 because the deadline expired. If it never completes, the process stays
alive for recovery; this deadline reports the stall rather than cancelling the
writer. The parent/helper force-kill policy above is separate [observed:
`src/shutdown-budget.ts`, `runRecordingShutdown`; `src/index.ts`, `serve` shutdown].
Once the in-process server installs its recording-aware signal handler, the
earlier startup handler defers cleanup to it, so capture and capabilities stay
active until recording finalization completes [observed: `src/index.ts`,
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
the manifest when the server stops during recording. If a
start request times out, the CLI cancels that recording ID so a late server
start cannot leave an active recording. A finalization failure makes shutdown
exit unsuccessfully after teardown. After an encoder or frame-transfer failure,
the recorder tries to finalize any frames already written. If the writer completes,
the error includes the path to a playable partial `recording.mp4`. No success
manifest is written, and that session cannot start another recording until
serve-sim restarts.
The foreground CLI gives a helper with a known active recording up to 65 seconds
to finalize after SIGTERM. Without a known active recording, it force-kills an
unresponsive helper after 500 ms. A stream-settings change uses the same
recording-aware wait before replacing the helper and reports a finalization
error while still starting the replacement.

The proposed build-tools integration lives in a separate eas-cli PR. Once
deployed, it will use this command in place of record-sim: one recorder per
booted device, retaining each completed recording for upload. A device restart
can produce a second file with a new recording ID. Roll out the serve-sim
version containing `record-video` before deploying that consumer; an older
binary cannot satisfy the command. The upload schema is unchanged.

## Performance and validation

With recording and N H.264 viewers, the intended cost is one framebuffer
capture, one shared viewer encode, and one full-resolution recording encode.
The former record-sim path took a second framebuffer capture and CPU-locked
copy. It also encoded independently of the WebRTC peers. For one viewer,
encoder count remains two; for two or more viewers, sharing removes the extra
per-viewer H.264 encodes. The second recording encode preserves native size
and cadence when viewer bitrate, resolution, or transport changes.

`viewerResize` reports scale latency.
