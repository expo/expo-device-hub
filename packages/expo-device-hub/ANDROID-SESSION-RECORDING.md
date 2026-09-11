# Android session recording PoC

Device Hub records the only booted Android emulator from startup through shutdown,
including periods with no preview viewer. Recording is opt-in and does not change
the existing action-event recorder.

## Run locally

Use a built workspace with `adb`, `ffmpeg`, `ffprobe`, and exactly one booted emulator.
The output directory must not contain a previous `recordings.json`.

```sh
node packages/expo-device-hub/dist/server/cli.mjs \
  --platform android \
  --android-recording-directory /tmp/my-android-session
```

Stop the Hub process with `SIGINT` or `SIGTERM`. Wait for exit before reading the
output. `recordings.json` contains one descriptor on success and remains empty on
failure. The descriptor's directory contains `recording.mp4` and `session.json`.
Do not send a process-group signal until recording has finalized, since it also
kills capture's ffmpeg child. EAS uses the authenticated stop endpoint first.

The default source is gRPC MMAP. `--stream-source scrcpy` uses the same recorder.
`/vendor/serve-emu/health` reports `screenRecording`, including its first-frame
time, frame count, queue size, and any failure.

## EAS integration

The companion change in `eas-cli/packages/build-tools` enables recording when the
build-step environment contains `EAS_ANDROID_SESSION_RECORDING=1`. Use a Device Hub
package version containing this PoC through the existing `package_version` input;
the currently published package is not changed by this branch.

EAS creates a fresh local directory and passes a random control token through the
child environment. On session stop it calls `POST /_eas/android-recording/stop`
with the token, waits up to 60 seconds for finalization, stops the preview process,
then passes the result to the existing screen-recording uploader. Stop calls are
idempotent. The process has a 70-second shutdown allowance when recording is on.
Upload failures are logged without hiding the local artifacts.

The upload retains the existing contract: artifact kind `screen-recording`,
`__eas_screen_recording=1`, emulator metadata, dimensions, and `firstFrameAt`.
This PoC requires changes only in `device-hub` and `eas-cli`, not `universe` or the
website. An actual hosted EAS upload and website playback still need verification.

## Recording behavior and limits

The recorder consumes H.264 in the existing capture reader before browser fanout.
It does not start another guest encoder. Mediabunny muxes Annex B packets into an
MP4 using source PTS differences. Each frame lasts until the next frame; the final
frame lasts until stop, so an idle screen does not shorten the timeline.

gRPC's first-frame time uses its host encoder-submission timestamp. Scrcpy pairs
its first received keyframe with host wall-clock time, then uses source PTS deltas.
Scrcpy capture-to-host latency is therefore an offset uncertainty for annotations.

- One booted emulator and one capture generation. No physical devices or multi-device recording.
- Source and encoder-setting changes return HTTP 409 while recording is active.
- Rotation, changed SPS/PPS, non-increasing timestamps, or capture failure fail the
  recording. Preview can continue; the incomplete file is not published for upload.
- Disk writes are queued separately from preview with a 16 MiB byte limit. A slow
  or failed writer fails recording without blocking preview. There is no total
  recording-size quota yet.
- MP4 and manifests are published only after finalization. A crash or forced kill
  may leave `.partial` files. There is no crash recovery or segment stitching.
- No audio. Recording begins before Hub readiness, not before emulator boot.

## Re-run verification

From the repository root, after building the native serve-sim dependency as usual:

```sh
bun run --filter serve-emu check
bun run --filter expo-device-hub build:vendor
bun run --filter expo-device-hub build:server
bun test packages/expo-device-hub/src/server/__tests__
bun packages/expo-device-hub/scripts/verify-android-recording.ts grpc-screenshot endpoint
bun packages/expo-device-hub/scripts/verify-android-recording.ts grpc-screenshot signal
bun packages/expo-device-hub/scripts/verify-android-recording.ts scrcpy endpoint
```

The live script uses the built Node CLI, starts with zero viewers, connects and
disconnects a WebSocket viewer, verifies stop-endpoint authentication, finalizes,
and checks the MP4 with `ffprobe` and a full ffmpeg decode. It checks increasing
packet timestamps and compares duration to wall time. It retains the video,
server log, and `verification.json` in a fresh temporary directory.

Recorder tests also cover large source timestamps, long idle intervals, missing
keyframes, configuration changes, queue overflow, writer failures, and a capture
failure during finalization. Companion EAS tests cover Linux artifact metadata,
opt-in arguments, stop ordering, and upload-once behavior.
