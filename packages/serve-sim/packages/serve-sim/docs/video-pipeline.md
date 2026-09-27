# Video pipeline and recording

This describes the H.264 WebRTC and session-recording paths. See
[WebRTC architecture](webrtc-architecture.md) for signaling and control, and
[API](api.md) for the recording endpoint. HTTP video remains a separate transport.

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

## WebRTC viewers

`ViewerFrameResizer` places each captured frame on the shared viewer canvas
on its own queue, so the frame pump never waits on a resize. The default
backend scales the Y and CbCr planes on the GPU with Metal Performance Shaders
(bilinear) into a bounded pool; a frame that already matches the canvas passes
through. The VideoToolbox transfer is the fallback, with its own vImage CPU
path. A frame that arrives while one is in flight replaces the waiting frame.
`SERVE_SIM_VIEWER_RESIZE=metal|videotoolbox|cpu` pins one backend for
measurements.

`WebRTCPublisher` paces the latest resized frame at the configured viewer rate.
When a 60 Hz source lands a fraction of a millisecond after a slot, the pump
waits one scheduling tolerance for it instead of repeating the previous frame;
an idle screen has no cadence and repeats at the configured rate. A frame from
before a canvas change is dropped at the pump rather than encoded at the wrong
size. Resized frames from an earlier viewer session are discarded after the
viewer acceptance generation changes. A custom H.264 encoder factory gives
each H.264 peer a proxy over one
`VTCompressionSession`.
Proxies deduplicate submissions by frame timestamp and distribute the one
compressed result to the peers. The shared target bitrate is the minimum of
active peers' requests; a join or PLI requests an IDR. Each peer still owns
its connection, congestion controller, and RTP packet stream.

All viewers use the shared input canvas. H.264 viewers share one encode;
VP8 viewers encode separately from that same canvas, including its letterboxing
and resolution limits.
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
the resize counters under `viewerResize`, and the pump deferrals, repeats, and
canvas-mismatch drops under `capture`.

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

Compressed H.264 samples go to `AVAssetWriterInput` with `outputSettings: nil`,
so the MP4 writer does not encode again. On successful finalization the output
directory contains `recording.mp4` and `session.json`. The manifest keeps the
record-sim upload contract: `firstFrameWallClock` with `unixMs` and `iso8601`,
`width`, `height`, and `recording`.

## Control and shutdown

Start serve-sim for the device, then run:

```sh
serve-sim record-video --udid <udid> --output <empty-dir>
# Send SIGINT to stop; the command exits after session.json is available.
```

The CLI owns a recording lease and renews it while running. A client with a
different recording ID cannot stop that recording. When the session uses
`--require-token`, the CLI sends its bearer token for recording control. An
ungated local session needs no token. Serve-sim finalizes an active recording
on SIGTERM, SIGINT, or SIGHUP before the process exits. The CLI also waits for
the manifest when the server stops during recording. If a
start request times out, the CLI cancels that recording ID so a late server
start cannot leave an active recording. A finalization failure makes shutdown
exit unsuccessfully after teardown.
Allow sufficient shutdown time for the VideoToolbox flush and MP4 writer.

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

`viewerResize` reports scale latency. Direct capture-copy latency and a
before-and-after CPU baseline against record-sim remain to be measured.
