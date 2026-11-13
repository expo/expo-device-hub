# LLP 0023: Android recording independent of the stream

**Type:** RFC
**Status:** Draft
**Systems:** Hub, ServeEmu, EmulatorCapture, HubClient
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-13
**Related:** LLP 0001, LLP 0013, LLP 0020, LLP 0021, LLP 0022, LLP 0018 (open in https://github.com/expo/expo-device-hub/pull/607)

> File paths in `src/` are relative to the package that the text names. serve-emu is `packages/serve-emu/packages/serve-emu`, the agent is `packages/expo-emulator-capture`, and the Hub is `packages/expo-device-hub`.

## Summary

The Hub's Android recording takes the encoded packets of the live stream. So a change to the stream, such as its size, frame rate, bit rate or source, and also a rotation or a fold, can end the recording. The Hub and HubClient therefore lock these controls while a recording runs.

This RFC gives the recording its own encode, with its own size, frame rate and bit rate, set once at the start. Out of the box, the recording uses the emulator's native resolution and its display refresh rate, typically 60 fps. The stream keeps its current defaults. Only the end of the device (shut down or removed), the stop request and the recording limits end a recording.

One product decision is open: where the second encode runs when the emulator capture is on. The options and a recommendation are in [Decision 1](#decision-1-where-the-second-encode-runs). Two smaller decisions follow it. No code changes until Krystof Woldrich decides.

> **Provenance.** Krystof Woldrich set the direction on 2026-11-13: decouple the recording options from the stream options; no UI action, such as a stream option change or a change of a device property that the Hub allows, may break the recording, unless the device is shut down or removed; the recording is configurable at the start, but needs no configuration: native resolution of the emulator and the screen frame rate, typically 60 fps; the stream keeps its current defaults [confirmed: Krystof Woldrich, 2026-11-13, relayed in the task brief]. The facts below come from the code on `feat/emulator-capture-attach` (3b87f221), from PR 607, and from the private findings repository `krystofwoldrich-agent/emulator-capture-findings` (tests from 2026-11-04 to 2026-11-10). The cost numbers for two encodes are estimates from those tests and are tagged `[inferred]`; nothing was measured for this RFC.

## How the recording works today

- **Start.** `--android-recording-directory` starts the recording when the Hub starts. It needs exactly one booted emulator then; otherwise the Hub starts without a recording and logs the reason [observed: `AndroidSession.startRecording` in Hub `src/server/android-session.ts`]. The router creates the `ScreenRecording` before the device's first app, and every app for that serial gets it [observed: `startScreenRecording` and `createDeviceApp` options in serve-emu `src/middleware.ts`].
- **Frames.** The app's capture reader gives every packet of the live stream to the recording before it sends it to viewers [observed: `startCaptureReader`, `opts.screenRecording?.accept(...)`]. So the recording has the stream's size, frame rate and bit rate. The stream defaults are a longest edge of 1280 pixels and 8 Mbit/s from scrcpy's defaults, and 60 fps from the Hub [observed: `SCRCPY_DEFAULTS` in serve-emu `src/scrcpy.ts`, `DEFAULT_VIDEO_FPS` in Hub `src/server/cli/options.ts`]. A Pixel 10 (1080×2424) therefore records at 570×1280 unless the Hub runs with `--max-dimension 0`.
- **What breaks it.** A `session` packet with another size fails the recording ("Recording does not support display size changes yet."), and so do new SPS or PPS ("…codec configuration changes yet.") [observed: `ScreenRecording.accept` in serve-emu `src/screen-recording.ts`]. A rotation, a fold, and every encoder setting change produce one of these. So serve-emu refuses stream setting changes and source switches while a recording is active (`ScreenRecordingConflictError`) [observed: `updateStreamEncoderSettings`, `performStreamModeSwitch` in `src/middleware.ts`], and HubClient ignores rotation, orientation, stream setting and source changes meanwhile ([LLP 0013](0013-hub-client-input-and-control.explainer.md#recording-lock)). LLP 0013 records that this lock is temporary [confirmed: Krystof Woldrich, 2026-10-27].
- **What ends it.** The stop route `POST /_eas/android-recording/stop` with the bearer token, `SIGTERM`, and the limits: 4 GiB, one hour, 256 MiB of free disk [observed: Hub `src/server/eas-endpoints.ts`, serve-emu `DEFAULT_RECORDING_LIMITS`]. Nothing finalizes the recording when the emulator exits; the stop request later finalizes what it has [observed: the only callers of `recorder.finish()` are `finishScreenRecording` and `stopAll` in `src/middleware.ts`].
- **With the emulator capture.** The agent serves one consumer at a time; a new connection replaces the old one with a `replaced` record ([LLP 0020](0020-emulator-capture-macos.explainer.md#socket-protocol)). serve-emu's capture session is that consumer, so the recording shares the agent's single encode with the viewers.
- **PR 607 (open).** For a foldable with gRPC capture, a second libx264 encoder in serve-emu encodes the recording on a fixed canvas from `hardware-qemu.ini`, with keyframes at most one second apart and a `deviceStates` timeline in serve-sim's format ([LLP 0018 in PR 607](https://github.com/expo/expo-device-hub/blob/krystof/android-fold-recording/llp/0018-serve-emu-fold-recording.spec.md)). Other devices and other sources keep the shared encode there.
- **serve-sim.** The iOS recorder already owns a separate VideoToolbox session, a fixed canvas at the largest native panel size, a 60 Hz target and keyframes at most one second apart ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#session-recording)). This RFC brings Android to the same model.

## What the findings say

From `emulator-capture-findings` (README, `webrtc-and-read-modes.md`, `linux.md`, `macos.md`, `encoders.md`, `mac-cpu.md`, `grpc-comparison.md`):

- **Today the recording and the viewer get the same frames.** On EAS Linux VMs with `-gpu lavapipe` or `-gpu swiftshader`, the Hub's recording had the WebRTC viewer's frame rate within 0.4 fps, at 1080×2424, 60 fps and 8 Mbit/s, because both take the agent's one encode. The Hub lost no frames and used 0.04 to 0.06 cores [observed: findings, 2026-11-07 and 2026-11-10].
- **The frame copy is the expensive part, not the encoder.** On Linux the copy runs inside the emulator's post and costs 6 to 9 ms with lavapipe. The agent never dropped a frame for a busy encoder. A 320×720 encode took 3.7 ms and a 1080×2424 encode 10.6 ms [observed: findings, 2026-11-07]. So a second encode can share the one copy.
- **Linux encode cost.** x264 ultrafast used 10.0 ms of CPU per 1080×2424 frame with four threads, which is about 0.6 cores at 60 fps. In the live test the encoder threads used 0.75 to 0.93 cores, and the emulator used 6.8 cores without a capture session and about 11 cores with one, on a 22-vCPU VM [observed: findings `encoders.md`, `webrtc-and-read-modes.md`].
- **macOS encode cost.** With `-gpu host`, the agent added 0.25 cores at 570×1280 and 0.32 cores at 1080×2424 over "no stream"; the consumer used 0.005 cores. VideoToolbox's `h264.rtvc` encoded synthetic 1080×2424 frames at 97 to 109 fps on an EAS M4 Pro VM, and one encode took 9.65 ms of wall time on the Mac mini M2 [observed: findings `mac-cpu.md`, `macos.md`].
- **gRPC at native size is slow without a GPU.** On EAS Linux VMs, the gRPC stream reached 38 to 50 fps at 1080×2424 and 56.7 to 60 fps at 570×1280. On the Mac with `-gpu host`, it reached 60 fps at both sizes, at 1.31 cores against 0.60 [observed: findings `grpc-comparison.md`, `mac-cpu.md`].
- **The panel size changes only with a fold.** The agent's color buffer keeps the panel orientation; the agent turns the picture upright for each consumer's `R` command ([LLP 0020](0020-emulator-capture-macos.explainer.md#rotation)). A fold changes the posted size, 2076×2152 open and 1080×2424 closed on the Pixel 9 Pro Fold [observed: findings `macos.md`].

## Requirements

1. **The recording owns its encode settings.** Size, frame rate and bit rate are set once, at the start, and nothing in the UI changes them.
2. **Defaults need no configuration.**
   - Size: the emulator's native resolution. For a foldable, the canvas fits every display, as in PR 607 and serve-sim.
   - Frame rate: the display's refresh rate, `hw.lcd.vsync` in the AVD's `hardware-qemu.ini` (60 on every AVD on the development Mac [observed: `~/.android/avd/*.avd/hardware-qemu.ini`, 2026-11-13]), capped at 120, the agent's limit.
   - Bit rate: 8 Mbit/s, the bit rate of the EAS tests at 1080×2424 and 60 fps. One hour at 8 Mbit/s is 3.6 GB, under the 4 GiB default limit. Krystof did not name a bit rate, so this is a proposal.
3. **Start options.** Three variables next to the existing limit variables, read and checked before any disk write as `recordingLimitsFromEnv` does: `EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION` (0 for native, 16 to 4096), `EXPO_DEVICE_HUB_RECORDING_FPS` (1 to 120) and `EXPO_DEVICE_HUB_RECORDING_BITRATE` (100 kbit/s to 50 Mbit/s, the agent's range).
4. **No UI action ends the recording.** This covers every stream option (size, frame rate, bit rate, transport, source, gRPC image mode, encoder, input source), viewers that join or leave, rotation and orientation, fold, and the device options (appearance, color filter, network, text size, display size, keyboard, location). Display size changes the density, not the pixel size [observed: `wm density` in serve-emu `src/adb.ts`; the `sw…dp` description in HubComponents `DeviceOptionsSection.tsx`].
5. **What ends it.** The stop request, `SIGTERM`, the limits, and the end of the device: the emulator shuts down, or it is removed. At the end of the device, the recording finalizes at once with what it has, with `stopReason: "device-ended"`, so that a later stop request publishes it.
6. **The stream keeps its defaults.** 1280 pixels, 8 Mbit/s, 60 fps, and the same default source.
7. **One file, one size.** An MP4 track keeps one size. The recording is in the panel orientation on a fixed canvas, so a rotation never changes its size, and `deviceStates` gives `orientation` for each part, as serve-sim does and as PR 607 does for folds. Keyframes are at most one second apart.

Requirement 7 follows from serve-sim's format and PR 607 [observed]. An upright recording would need a square canvas of the long edge (2424×2424 for a Pixel 10), with black bars in each orientation.

## Shape common to every option

- **The router owns the recording pipeline per serial, apart from apps.** Today an app and its capture generations carry the recorder. The recording gets its own source object that the router creates at the start and keeps until the recording ends. A stream setting change, a source switch, or an app restart does not touch it. serve-emu removes the `ScreenRecordingConflictError` guards for an independent recording.
- **Status.** The `/api` recording status adds `independent: true`. HubClient's `recordingLock` is null for such a recording, so the dashboard enables every control. An older server without the field keeps the lock, as `followsFold` does in PR 607.
- **Device end.** The recording source watches the device, through the agent socket closing and the adb device list, and finalizes on its end.

## Decision 1: where the second encode runs

This decision applies when the emulator capture is on and the agent serves the device. It is the case that EAS testing builds use (https://github.com/expo/expo-device-hub/pull/575).

### Option A: the agent encodes twice (recommended)

The agent serves two consumers at once, each with its own role: one **stream** consumer and one **recording** consumer. The render thread copies each frame once; each role has its own encoder thread, settings, rotation, output queue and replaced rule.

- **Protocol 3.** A consumer sends a role command before `S`. A consumer without it is a stream consumer, so serve-emu builds before this change keep working. A new consumer replaces only the consumer of its own role. Hello's `protocol` becomes 3.
- **Shared frames.** The frame source keeps one copy per post and gives a reference to each active role: a retained `CVPixelBuffer` on macOS, a shared pooled RGBA image on Linux. The pacer runs at the highest frame rate of the active roles, and each role paces its own encoder.
- **The recording role.** No rotation (panel orientation), a fixed canvas from serve-emu (a new command), letterboxing in the encoder (VideoToolbox pixel transfer, as serve-sim's recorder does; scaling into padded I420 planes with x264), keyframes at most one second apart, and a larger output queue than the stream, because the consumer writes to a local disk.
- **serve-emu.** The recording source connects to the agent as the recording role and feeds `ScreenRecording`. The stream session is unchanged, so the user can switch the stream to gRPC or scrcpy while the recording keeps the agent.
- **Cost, Linux.** A second x264 encode at native size: about 0.6 to 0.9 cores at 60 fps, from the benchmark and the live test. The stream at 570×1280 has 28% of the pixels, about 0.17 to 0.26 cores. So the default case uses about 0.8 to 1.2 cores for encoding, against 0.17 to 0.26 today, on a VM where the emulator uses 7 to 11 of 22 cores [inferred: scaled from the findings]. The copy on the render thread, which sets the frame rate, does not double.
- **Cost, macOS.** A second VideoToolbox session on the hardware encoder. The CPU cost is below the agent's total of 0.25 to 0.32 cores [inferred]. Two streams at 60 fps (1080×2424 and 570×1280) need about 77 full-size frames per second of the encoder, under the 97 to 109 fps that the M4 Pro VM reached [inferred]. The M2 limit is not measured.
- **For.** The same model as serve-sim's recorder. The recording does not depend on serve-emu's stream session, its reconnects, or its source. Each encode is done once, in the place that has the frames.
- **Against.** Native code changes in both agents and a new agent release, which the Hub's pinned agent version requires anyway ([LLP 0020](0020-emulator-capture-macos.explainer.md#integration)). LLP 0020's "one consumer at a time" rule changes to one consumer per role.

### Option B: one native encode in the agent; serve-emu derives the stream

The agent's single consumer becomes the recording source at native size. serve-emu decodes that stream and encodes the live stream at the stream settings with its ffmpeg encoders (libx264, `h264_videotoolbox`, NVENC or VAAPI [observed: `FFMPEG_ENCODER_NAMES` in serve-emu `src/h264-encoder.ts`]). When the stream settings match the recording, serve-emu forwards the packets unchanged.

- **For.** No agent change. One agent consumer, as today.
- **Against.** A decode and an encode in the Hub's process tree for every viewer frame, and one or two more frames of delay on the live stream [inferred]. The cost is not measured. On Linux it is a software decode at native size plus a libx264 encode. A failed transcode ends the live stream while the agent still sends frames.

### Option C: one shared native encode

The stream uses the recording's native encode while a recording runs, and stream setting changes do not apply then. This breaks requirement 6: viewers would get 1080×2424 instead of 570×1280, and the stream options would do nothing. **Not recommended.** A variant that moves the stream to gRPC while the agent records changes the stream's default source, which breaks requirement 6 too.

### Recommendation

Option A. The findings show that the copy is the expensive part, and Option A makes that copy once. It follows serve-sim's recorder, it keeps the stream exactly as it is, and the extra CPU is one software encode on Linux and almost nothing on macOS. Before the release, an EAS Linux run must check that two encodes keep 60 fps at the viewer and in the recording (see the test plan).

## Decision 2: a recording without the agent

The capture is off, the agent is missing, or the attach failed ([LLP 0022](0022-emulator-capture-attach.explainer.md)). The recording then cannot use the agent.

- **2a. Its own gRPC screenshot stream at native size and its own libx264 encoder in serve-emu.** This extends PR 607's recording encoder to every device. It costs a second gRPC stream; at native size without a GPU, gRPC reaches only 38 to 50 fps on EAS Linux [observed: findings]. The two gRPC streams together are not measured.
- **2b. The recording encoder takes the stream's gRPC images (as PR 607 does) and scales them to its fixed canvas.** Stream setting changes no longer end the recording, but its sharpness follows the stream size, and a switch to scrcpy still ends it.
- **2c. Keep today's behavior without the agent.** The status has no `independent` field, and the lock stays for that recording.

**Recommendation:** 2c in the first change, which covers the capture as Krystof asked; then 2a in a follow-up, after PR 607, because 2a builds on PR 607's recording encoder.

## Decision 3: order with PR 607

PR 607 is open on `main` and changes the same files: `screen-recording.ts`, `middleware.ts` and `h264-encoder.ts` in serve-emu, and HubClient's recording lock. Its fixed canvas, `deviceStates` timeline, hinge feed and one-second keyframes are what requirement 7 needs.

**Recommendation:** merge PR 607 first, rebase the capture stack (https://github.com/expo/expo-device-hub/pull/570, https://github.com/expo/expo-device-hub/pull/571, https://github.com/expo/expo-device-hub/pull/574) on it, and build this change on top, so it reuses PR 607's canvas and timeline instead of a second copy of them.

## Test plan (after the implementation)

No emulator ran for this RFC. Unit tests cover the protocol roles, the shared frames, the option parsing and the router's independent recording. The device tests are still to do:

1. **macOS, Mac mini M2, `-gpu host`, Pixel 10.** Start the Hub with `--android-recording-directory` and the capture on. While it records, change the stream size (1280, 720, 0), the frame rate (60, 30), the bit rate, the transport (WebSocket, WebRTC) and the source (capture, gRPC, scrcpy, capture); turn the device four times; change appearance, text size and display size; close every viewer and open two tabs. Stop with `POST /_eas/android-recording/stop`. Expect a complete `recording.mp4` at 1080×2424, one track, about 60 changed frames per second in the busiest seconds, keyframes at most one second apart, and `deviceStates` with each orientation.
2. **The same with the Pixel 9 Pro Fold.** Fold and unfold during the recording. Expect one canvas size and `screen` entries for `inner` and `outer`.
3. **EAS Linux VM, `-gpu lavapipe`.** The app-action script and the page that changes every frame, with the WebRTC viewer at the default 570×1280 and the recording at native size. Measure the frame rate of both, and the CPU of each agent encoder thread, against one encode.
4. **Device end.** Stop the emulator during a recording. Expect `stopReason: "device-ended"`, and a stop request that then answers 200.
5. **Two Hubs.** A second Hub that streams the same emulator replaces only the stream consumer; the recording goes on.

## Open questions

- Should the recording repeat the last frame on a still screen, as serve-sim's 60 Hz timer does? The MP4 keeps real frame times, so a still screen is one long frame; repeats only help players that need a constant rate.
- Should the default bit rate scale with the native pixel count? 8 Mbit/s is the tested value at 1080×2424; a 2076×2424 fold canvas has twice the pixels.
