# LLP 0023: Android recording independent of the stream

**Type:** RFC
**Status:** Draft
**Systems:** Hub, ServeEmu, EmulatorCapture, HubClient
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-13
**Revised:** 2026-11-13 (decisions confirmed; the implementation in [As built](#as-built); device test results); 2026-11-14 (on Linux, one read on the capture thread for both roles; the Linux timing matrix in [Test plan and results](#test-plan-and-results)); by Claude Code, directed by Krystof Woldrich; 2026-11-14 (restack preserves inherited native failure guards, bounded socket reads and tail retry ownership), by Codex (gpt-6.1-sol), directed by Krystof Woldrich
**Related:** LLP 0001, LLP 0013, LLP 0018, LLP 0020, LLP 0021, LLP 0022 (attach to a running emulator, in a later PR of the stack)

> File paths in `src/` are relative to the package that the text names. serve-emu is `packages/serve-emu/packages/serve-emu`, the agent is `packages/expo-emulator-capture`, and the Hub is `packages/expo-device-hub`.

## Summary

The Hub's Android recording takes the encoded packets of the live stream. So a change to the stream, such as its size, frame rate, bit rate or source, and also a rotation or a fold, can end the recording. The Hub and HubClient therefore lock these controls while a recording runs.

This RFC gives the recording its own encode, with its own size, frame rate and bit rate, set once at the start. Out of the box, the recording uses the emulator's native resolution and its display refresh rate, typically 60 fps. The stream keeps its current defaults. Only the end of the device (shut down or removed), the stop request and the recording limits end a recording.

Krystof Woldrich decided the three open questions on 2026-11-13: the emulator capture agent encodes twice, once for the stream and once for the recording ([Decision 1](#decision-1-where-the-second-encode-runs), Option A); without the agent, the recording and its lock stay as before ([Decision 2](#decision-2-a-recording-without-the-agent), 2c); and the change builds on the foldable recording of [LLP 0018](0018-serve-emu-fold-recording.spec.md) ([Decision 3](#decision-3-order-with-pr-607)) [confirmed: Krystof Woldrich, 2026-11-13]. [As built](#as-built) describes the implementation, and [Test plan and results](#test-plan-and-results) what ran.

> **Provenance.** Krystof Woldrich set the direction on 2026-11-13: decouple the recording options from the stream options; no UI action, such as a stream option change or a change of a device property that the Hub allows, may break the recording, unless the device is shut down or removed; the recording is configurable at the start, but needs no configuration: native resolution of the emulator and the screen frame rate, typically 60 fps; the stream keeps its current defaults [confirmed: Krystof Woldrich, 2026-11-13, relayed in the task brief]. He then chose Option A, 2c and the order with PR 607 [confirmed: Krystof Woldrich, 2026-11-13, relayed in the task brief]. The facts in the sections up to the decisions come from the code on `feat/emulator-capture-attach` (3b87f221), from PR 607, and from the private findings repository `krystofwoldrich-agent/emulator-capture-findings` (tests from 2026-11-04 to 2026-11-10). The cost numbers for two encodes in the options are estimates from those tests and are tagged `[inferred]`. Claude Code wrote [As built](#as-built) while it implemented the change; the choices there that the decisions do not cover are listed under [Choices made while building](#choices-made-while-building), and human review is pending.

## How the recording worked before this change

This section describes the code before this change. Without the agent, the recording still works this way (Decision 2c).

- **Start.** `--android-recording-directory` starts the recording when the Hub starts. It needs exactly one booted emulator then; otherwise the Hub starts without a recording and logs the reason [observed: `AndroidSession.startRecording` in Hub `src/server/android-session.ts`]. The router creates the `ScreenRecording` before the device's first app, and every app for that serial gets it [observed: `startScreenRecording` and `createDeviceApp` options in serve-emu `src/middleware.ts`].
- **Frames.** The app's capture reader gives every packet of the live stream to the recording before it sends it to viewers [observed: `startCaptureReader`, `opts.screenRecording?.accept(...)`]. So the recording has the stream's size, frame rate and bit rate. The stream defaults are a longest edge of 1280 pixels and 8 Mbit/s from scrcpy's defaults, and 60 fps from the Hub [observed: `SCRCPY_DEFAULTS` in serve-emu `src/scrcpy.ts`, `DEFAULT_VIDEO_FPS` in Hub `src/server/cli/options.ts`]. A Pixel 10 (1080×2424) therefore records at 570×1280 unless the Hub runs with `--max-dimension 0`.
- **What breaks it.** A `session` packet with another size fails the recording ("Recording does not support display size changes yet."), and so do new SPS or PPS ("…codec configuration changes yet.") [observed: `ScreenRecording.accept` in serve-emu `src/screen-recording.ts`]. A rotation, a fold, and every encoder setting change produce one of these. So serve-emu refuses stream setting changes and source switches while a recording is active (`ScreenRecordingConflictError`) [observed: `updateStreamEncoderSettings`, `performStreamModeSwitch` in `src/middleware.ts`], and HubClient ignores rotation, orientation, stream setting and source changes meanwhile ([LLP 0013](0013-hub-client-input-and-control.explainer.md#recording-lock)). LLP 0013 records that this lock is temporary [confirmed: Krystof Woldrich, 2026-10-27].
- **What ends it.** The stop route `POST /_eas/android-recording/stop` with the bearer token, `SIGTERM`, and the limits: 4 GiB, one hour, 256 MiB of free disk [observed: Hub `src/server/eas-endpoints.ts`, serve-emu `DEFAULT_RECORDING_LIMITS`]. Nothing finalizes the recording when the emulator exits; the stop request later finalizes what it has [observed: the only callers of `recorder.finish()` are `finishScreenRecording` and `stopAll` in `src/middleware.ts`].
- **With the emulator capture.** The agent serves one consumer at a time; a new connection replaces the old one with a `replaced` record ([LLP 0020](0020-emulator-capture-macos.explainer.md#socket-protocol)). serve-emu's capture session is that consumer, so the recording shares the agent's single encode with the viewers.
- **PR 607.** For a foldable with gRPC capture, a second libx264 encoder in serve-emu encodes the recording on a fixed canvas from `hardware-qemu.ini`, with keyframes at most one second apart and a `deviceStates` timeline in serve-sim's format ([LLP 0018](0018-serve-emu-fold-recording.spec.md)). Other devices and other sources keep the shared encode there.
- **serve-sim.** The iOS recorder already owns a separate VideoToolbox session, a fixed canvas at the largest native panel size, a 60 Hz target and keyframes at most one second apart ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#session-recording)). This RFC brings Android to the same model.

## What the findings say

From `emulator-capture-findings` (README, `webrtc-and-read-modes.md`, `linux.md`, `macos.md`, `encoders.md`, `mac-cpu.md`, `grpc-comparison.md`):

- **Today the recording and the viewer get the same frames.** On EAS Linux VMs with `-gpu lavapipe` or `-gpu swiftshader`, the Hub's recording had the WebRTC viewer's frame rate within 0.4 fps, at 1080×2424, 60 fps and 8 Mbit/s, because both take the agent's one encode. The Hub lost no frames and used 0.04 to 0.06 cores [observed: findings, 2026-11-07 and 2026-11-10].
- **The frame copy is the expensive part, not the encoder.** On Linux the copy ran inside the emulator's post and cost 6 to 9 ms with lavapipe (since 2026-11-14, a capture thread reads the frame of the post before: [LLP 0021](0021-emulator-capture-linux.explainer.md#frame-path)). The agent never dropped a frame for a busy encoder. A 320×720 encode took 3.7 ms and a 1080×2424 encode 10.6 ms [observed: findings, 2026-11-07]. So a second encode can share the one copy.
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

### Option A: the agent encodes twice (decided)

The agent serves two consumers at once, each with its own role: one **stream** consumer and one **recording** consumer. The agent copies each frame once; each role has its own encoder thread, settings, rotation, output queue and replaced rule.

- **Protocol 3.** A consumer sends a role command before `S`. A consumer without it is a stream consumer, so serve-emu builds before this change keep working. A new consumer replaces only the consumer of its own role. Hello's `protocol` becomes 3.
- **Shared frames.** The frame source keeps one copy per post and gives a reference to each active role: a retained `CVPixelBuffer` on macOS, a shared pooled RGBA image on Linux. The pacer runs at the highest frame rate of the active roles, and each role paces its own encoder.
- **The recording role.** No rotation (panel orientation), a fixed canvas from serve-emu (a new command), letterboxing in the encoder (VideoToolbox pixel transfer, as serve-sim's recorder does; scaling into padded I420 planes with x264), keyframes at most one second apart, and a larger output queue than the stream, because the consumer writes to a local disk.
- **serve-emu.** The recording source connects to the agent as the recording role and feeds `ScreenRecording`. The stream session is unchanged, so the user can switch the stream to gRPC or scrcpy while the recording keeps the agent.
- **Cost, Linux.** A second x264 encode at native size: about 0.6 to 0.9 cores at 60 fps, from the benchmark and the live test. The stream at 570×1280 has 28% of the pixels, about 0.17 to 0.26 cores. So the default case uses about 0.8 to 1.2 cores for encoding, against 0.17 to 0.26 today, on a VM where the emulator uses 7 to 11 of 22 cores [inferred: scaled from the findings]. The frame copy, which sets the frame rate, does not double.
- **Cost, macOS.** A second VideoToolbox session on the hardware encoder. The CPU cost is below the agent's total of 0.25 to 0.32 cores [inferred]. Two streams at 60 fps (1080×2424 and 570×1280) need about 77 full-size frames per second of the encoder, under the 97 to 109 fps that the M4 Pro VM reached [inferred]. The M2 limit is not measured.
- **For.** The same model as serve-sim's recorder. The recording does not depend on serve-emu's stream session, its reconnects, or its source. Each encode is done once, in the place that has the frames.
- **Against.** Native code changes in both agents and a new agent release, which the Hub's pinned agent version requires anyway ([LLP 0020](0020-emulator-capture-macos.explainer.md#integration)). LLP 0020's "one consumer at a time" rule changes to one consumer per role.

### Option B: one native encode in the agent; serve-emu derives the stream

The agent's single consumer becomes the recording source at native size. serve-emu decodes that stream and encodes the live stream at the stream settings with its ffmpeg encoders (libx264, `h264_videotoolbox`, NVENC or VAAPI [observed: `FFMPEG_ENCODER_NAMES` in serve-emu `src/h264-encoder.ts`]). When the stream settings match the recording, serve-emu forwards the packets unchanged.

- **For.** No agent change. One agent consumer, as today.
- **Against.** A decode and an encode in the Hub's process tree for every viewer frame, and one or two more frames of delay on the live stream [inferred]. The cost is not measured. On Linux it is a software decode at native size plus a libx264 encode. A failed transcode ends the live stream while the agent still sends frames.

### Option C: one shared native encode

The stream uses the recording's native encode while a recording runs, and stream setting changes do not apply then. This breaks requirement 6: viewers would get 1080×2424 instead of 570×1280, and the stream options would do nothing. **Not recommended.** A variant that moves the stream to gRPC while the agent records changes the stream's default source, which breaks requirement 6 too.

### Recommendation and decision

Option A, which Krystof Woldrich chose [confirmed: Krystof Woldrich, 2026-11-13]. The findings show that the copy is the expensive part, and Option A makes that copy once. It follows serve-sim's recorder, it keeps the stream exactly as it is, and the extra CPU is one software encode on Linux and almost nothing on macOS. Before the release, an EAS Linux run must check that two encodes keep 60 fps at the viewer and in the recording (see the test plan).

## Decision 2: a recording without the agent

The capture is off, the agent is missing, or the attach failed (LLP 0022, in a later PR of the stack). The recording then cannot use the agent.

- **2a. Its own gRPC screenshot stream at native size and its own libx264 encoder in serve-emu.** This extends PR 607's recording encoder to every device. It costs a second gRPC stream; at native size without a GPU, gRPC reaches only 38 to 50 fps on EAS Linux [observed: findings]. The two gRPC streams together are not measured.
- **2b. The recording encoder takes the stream's gRPC images (as PR 607 does) and scales them to its fixed canvas.** Stream setting changes no longer end the recording, but its sharpness follows the stream size, and a switch to scrcpy still ends it.
- **2c. Keep today's behavior without the agent.** The status has no `independent` field, and the lock stays for that recording.

**Recommendation:** 2c in the first change, which covers the capture as Krystof asked; then 2a in a follow-up, after PR 607, because 2a builds on PR 607's recording encoder.

**Decision:** 2c [confirmed: Krystof Woldrich, 2026-11-13]. 2a stays a possible follow-up.

## Decision 3: order with PR 607

PR 607 is open on `main` and changes the same files: `screen-recording.ts`, `middleware.ts` and `h264-encoder.ts` in serve-emu, and HubClient's recording lock. Its fixed canvas, `deviceStates` timeline, hinge feed and one-second keyframes are what requirement 7 needs.

**Recommendation:** merge PR 607 first, rebase the capture stack (https://github.com/expo/expo-device-hub/pull/570, https://github.com/expo/expo-device-hub/pull/571, https://github.com/expo/expo-device-hub/pull/574) on it, and build this change on top, so it reuses PR 607's canvas and timeline instead of a second copy of them.

**Decision:** build on PR 607's work [confirmed: Krystof Woldrich, 2026-11-13]. The change sits on a temporary copy of PR 607 (https://github.com/expo/expo-device-hub/pull/621) at the top of the capture stack, and it reuses LLP 0018's canvas, timeline and hinge feed.

## As built

### Agent protocol 3

- **Roles.** A consumer sends `U` and one big-endian u32 before its first `S`: 0 for the stream, 1 for the recording. Its first `S` assigns the role; a consumer without `U` is a stream consumer, so older serve-emu builds work as before. A consumer of the same role that was there before gets the `replaced` record and closes; the other role goes on. A connection that has not sent `S` yet replaces nobody, and the agent keeps at most four of them [observed: `assignRole`, `accept` and `kMaxConnections` in `src/native/agent.cpp`].
- **Canvas.** `C` and two big-endian u32 values set the recording's canvas, even edges from 2 to 4096. Without `C`, the recording takes the first frame's size, capped by the `S` longest edge, and keeps it [observed: `parseCanvas` in `src/native/protocol.h`, `encoderLoop`].
- **Hello** reports `protocol: 3` and `clockUs`, the agent's timestamp clock when it sends hello, so a consumer can move frame timestamps onto its own monotonic clock [observed: `helloJson`].
- **Configured** carries `role`. For the recording, it also carries `contentRect`, where the native frame sits on the canvas, and `fromPts`, the timestamp of the first frame that has this place. A fold sends `resized`, `configured` and an IDR, as for the stream, but the recording's encoder and canvas stay [observed: `configuredJson`, `encoderLoop`].
- **One copy, two encoders.** Each role has its own encoder thread, settings, pending frames and frame pacer. Each post asks each active role's pacer whether it takes the frame, the frame is copied once if any role does, and each of those roles gets a reference: a retained `CVPixelBuffer` on macOS, a shared pooled RGBA image on Linux. So the copy runs at the highest rate of the active roles [observed: `capturePost`, `deliver`; `FramePixels` in `src/native/frame.h`]. On macOS the post copies its own frame. On Linux the post hands the frame of the post before to the capture thread, which copies it once for the roles that took it; a newer post replaces a request that the thread has not taken, for the roles of both. The capture thread also applies the tail rule for every active role: the last post's frame, 50 ms after that post, past the pacers ([LLP 0021](0021-emulator-capture-linux.explainer.md#frame-path)) [observed: `captureLoop`, `deliverTail` in `src/native/agent.cpp`]. A tail claim keeps its handle, original post timestamp and sequence; failed reads retry only while that sequence remains current, so a new post or a reset supersedes the retry [observed: `LagTail` in `src/native/lag-tail.h`, `deliverTail` and `captureLoop`]. The frame source now tags the color attachments when it captures, because two encoder threads read the same buffer [observed: `IOSurfaceFrameSource::capture`]. The IOSurface target cache holds 12 and the Linux image pool 8, for the frames that both roles hold [observed: `kMaxTargets`, `kMaxPooledImages`].
- **The recording role** ignores `R` and keeps the panel orientation. Its encoder letterboxes each frame on the canvas with `placeOnCanvas`, the same placement as serve-emu's: centered, at its own size when it fits, scaled down otherwise, with even values [observed: `placeOnCanvas` in `src/native/protocol.h`]. VideoToolbox places the frame with a pixel transfer session in letterbox mode with a destination clean aperture, as serve-sim's `PixelBufferLetterboxer` does; x264 fills black I420 planes once per placement and converts each frame into the rectangle [observed: `placedTransfer` in `src/native/encoder-videotoolbox.mm`; `fillI420`, `subPlanes` in `src/native/yuv.h`]. Keyframes come at most one second apart: the encoder's interval is one second, and the agent forces a keyframe by timestamp, less half a frame, because gfxstream posts only when the screen changes [observed: `kRecordingKeyFrameIntervalSeconds`, `encoderLoop`]. Its output queue drops delta frames above 64 MB and closes the consumer above 128 MB, against 8 MB and 32 MB for the stream [observed: `kMaxQueuedOutputBytes`, `kMaxBufferedOutputBytes`].

### Recording source in serve-emu

- **The router owns it.** When the recording starts and the emulator has an agent socket, the router reads the emulator's `hardware-qemu.ini`, reads the orientation (and a foldable's hinge) before any frame can arrive, and connects to the agent as the recording consumer. An agent that does not answer, is older than protocol 3, or cannot encode leaves the recording on the stream's packets (Decision 2c), and the log says why [observed: `startIndependentRecording` in `src/middleware.ts`; `startCaptureRecordingSource` in `src/capture-recording-source.ts`].
- **Canvas and settings.** The canvas is the native display, or for a foldable the bounding box of both displays, each capped at the longest edge in the agent's integer steps [observed: `captureRecordingCanvas`]. The frame rate is `hw.lcd.vsync`, capped at 120, else 60; the bit rate is 8 Mbit/s; a start request can set all three [observed: `captureRecordingEncoding`, `displayRefreshRate`].
- **Frames.** The source moves each frame's timestamp onto the host clock with hello's `clockUs`, so the pose readings of [LLP 0018](0018-serve-emu-fold-recording.spec.md#device-state-timeline) apply. Each frame gets the geometry of the last `configured` record whose `fromPts` is not later than the frame: the native size, `screen` for a foldable, and `contentRect`. Every recording from the agent therefore has a `deviceStates` timeline, also for a device with one display, without `screen` [observed: `onRecord`, `geometryAt`].
- **Poses.** LLP 0018's hinge feed reads the hinge every 100 ms for a foldable, and only the orientation every second for other devices. The orientation comes from the current app's device state, which a rotation through the Hub sets at once, else from adb. A rotation and a fold through the Hub read at once [observed: `startFoldRecordingFeed` call and `onDisplayChanged` in `src/middleware.ts`].
- **Apps.** An app never feeds an independent recording and never refuses a stream change or `/api/fold` for it. A source switch does not touch it [observed: `recorder` in `createAppInternal`, `performStreamModeSwitch`]. `/api` and `/health` report `independent: true` while it waits, records or finalizes; a foldable's recording also reports `followsFold: true`, for clients that know only that field [observed: `ScreenRecording.snapshot`].
- **The end of the device.** When the agent closes the connection, the source asks adb's device list and connects again. A device that adb no longer lists, a socket that nothing answers, or a hello whose clock is smaller than the last frame (a new emulator) ends the device: the recording finishes at once with `stopReason: "device-ended"`, and a later stop request publishes it. More than three reconnects in a minute fail the recording, and so does a `replaced` record, which means that another program took the recording role [observed: `lost`, `ended` in `src/capture-recording-source.ts`; `ScreenRecording.endWithDevice`].
- A finished or failed recording closes the agent connection, also on a still screen [observed: `activeCheck`, `releaseRecording`].

### Hub options

`EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION` (0 or 16 to 4096), `EXPO_DEVICE_HUB_RECORDING_FPS` (1 to 120) and `EXPO_DEVICE_HUB_RECORDING_BITRATE` (100000 to 50000000) are read and checked with the limit variables, before any disk write, and an invalid value names the variable [observed: `recordingEncodingFromEnv` in Hub `src/server/recording-limits.ts`, `startAndroidScreenRecording` in `src/server/serve-emu.ts`]. They apply only to a recording that the agent encodes.

### HubClient

`recordingLock` is null when the status reports `independent: true`, so every control stays available; `status-unknown` stays until the first status arrives. A status without the field keeps the lock, as for `followsFold` [observed: `recordingLockReason`, `screenRecordingIndependent` in `packages/@expo/hub-client/src/screen-recording.ts`].

## Choices made while building

These are Claude Code's choices where the decisions did not say; human review is pending.

- A `replaced` record on the recording consumer fails the recording, because it means that another program, such as a second Hub with its own recording, took the recording role. Finishing the recording would also be possible.
- When the agent drops the recording consumer while the device runs, as for a consumer that stopped reading, the source connects again. The new encoder's SPS and PPS must match the old ones, or the recording fails, as after a capture restart before this change.
- The protocol letters `U` (role) and `C` (canvas), and a role that a connection takes with its first `S`, not when it connects.

## Test plan and results

Unit tests cover the protocol roles, the canvas and placement, the letterbox planes, the option parsing, the recording source against a fake agent socket (roles, canvas, timeline, fold, reconnect, device end, a new agent, replaced), the router's independent recording and its fallback, the app's stream changes during each kind of recording, and HubClient's lock.

1. **macOS, Mac mini M2, `-gpu host`, Pixel 10 (1080×2424), emulator 37.2.7.** Ran 2026-11-13. A Hub from this branch on port 3610 with `--android-recording-directory` and the capture on, a page in Chrome that changes color every frame, and one viewer. While it recorded, `/api` changes of the stream size (720, 0, 1280), frame rate (30, 60), bit rate (4, 8 Mbit/s), source (gRPC, scrcpy, capture), four rotations, dark mode, text size and display size all answered 200, and the recording status stayed `recording` with `independent: true`. The viewer showed the stream and rotation controls enabled. The viewer was closed and two tabs opened, and the Rotate button turned the device. `POST /_eas/android-recording/stop` answered 200. The MP4 has one H.264 track at 1080×2424, 16367 frames in 459 s, keyframes at most 0.99 s before any later delta frame, 60 changed frames per second in the three busiest seconds (ffmpeg `mpdecimate` on copies 570 pixels wide), and a `deviceStates` entry for each orientation. In this run, the first entry had no `orientation`: the router read it only after the agent sent the first frame, and the screen was still for the next 15 s. The router now reads it before it connects, and run 4 had it from the first frame. The seconds with fewer frames are the seconds of the source switch, the rotations and the configuration changes, while Android redraws Chrome [observed: 2026-11-13]. The WebRTC transport was tested in run 4 below; this Hub run offered only WebSocket.
2. **macOS, Pixel 9 Pro Fold.** Ran 2026-11-13. The recording used a 2076×2424 canvas. Folding and unfolding through `/api/fold` gave `deviceStates` entries `inner` (`contentRect` 0, 136, 2076×2152, hinge 180), `outer` (498, 0, 1080×2424, hinge 0) and `inner` again; decoded frames show each display at its place with black borders [observed: 2026-11-13].
3. **EAS Linux VM, `-gpu lavapipe`.** Ran 2026-11-13 (`linux-large-nested-virtualization`, image `ubuntu-26.04-jdk-17-ndk-r27b-sdk-58`, Pixel 10 profile on API 36), with this branch's Linux agent and a packed Hub from this branch. The agent's native and JavaScript tests passed on the VM. Through the Hub, with a WebRTC viewer: stream size and source changes and two rotations answered 200, the recording stayed independent, and the MP4 had one 1080×2424 track with keyframes at most 0.991 s before a later delta frame. The end of the device gave `device-ended` within two seconds, and the stop request then answered 200 [observed: EAS run, 2026-11-13].

   On 2026-11-14, after the rebase on the Linux read of the frame of the post before ([LLP 0021](0021-emulator-capture-linux.explainer.md#frame-path)), a timing matrix ran on one VM: 22 vCPUs, an Intel Xeon Platinum 8481C with 11 cores and 2 threads per core, emulator 37.1.11, API 36, `-gpu lavapipe`, the agent and Hub from the attach PR's head (`d0f3b929`). Two devices ran one after the other: the Pixel 10 profile (1080×2424) and the Medium Phone that EAS sessions use, created as eas-cli's build-tools creates it: in `hardware-qemu.ini`, the 720×1600 screen at 300 ppi and `hw.ramSize` 4096 took effect, but `vm.heapSize` was 576, not the 768 in `config.ini`. The page painted each frame in the next of eight colors; Chrome's frame counter came through DevTools. Each variant had two windows of 30 s and one with the probe, with direct socket consumers: the stream at 12 Mbit/s and the recording at 8 Mbit/s, both at 60 fps. The tables give the mean of the two windows [observed: EAS run `01a1d77b-5e4e-7ed0-896e-3e6ce74950fb`, 2026-11-14]. An earlier run of the same matrix on another VM gave values within 1.5 fps [observed: EAS run `01a1d74b-9b89-718e-8daa-58bf1e0a3383`, 2026-11-14].

   Pixel 10, 1080×2424. Without a consumer, Chrome drew 59.7 frames per second, and the emulator posted 60.0, with QEMU at 10.9 cores. A read took 8.6 to 9.5 ms, of which a 1×1 read took 5.5 to 6.2 ms.

   | Variant             | Chrome fps | Posts/s | Encoded fps | Pacer drops/s (stream) | Changed fps at the consumer | Encode ms (convert + x264) | Encoder cores | QEMU cores |
   | ------------------- | ---------- | ------- | ----------- | ---------------------- | --------------------------- | -------------------------- | ------------- | ---------- |
   | 1. Stream 960       | 53.3       | 58.9    | 57.3        | 1.7                    | 51.8                        | 5.0 + 1.4                  | 0.41          | 11.2       |
   | 2. Stream 1280      | 52.9       | 58.8    | 57.1        | 1.7                    | 51.4                        | 8.6 + 2.2                  | 0.70          | 11.3       |
   | 3. 960 + native     | 49.6       | 57.8    | 55.4, 55.3  | 2.5                    | 47.3, 47.3                  | 5.1 + 1.5; 5.7 + 5.1       | 0.41 + 0.93   | 11.7       |
   | 4. 1280 + native    | 48.4       | 57.8    | 55.5, 55.6  | 2.2                    | 46.5, 46.4                  | 8.8 + 2.1; 5.7 + 5.1       | 0.69 + 0.94   | 12.0       |
   | 5. 960 + 960        | 51.9       | 58.8    | 57.3, 57.3  | 1.5                    | 50.5, 50.4                  | 5.1 + 1.4; 5.1 + 1.4       | 0.43 + 0.43   | 11.4       |
   | 6. 1280 + 1280      | 50.5       | 58.1    | 55.9, 55.8  | 2.2                    | 48.5, 48.5                  | 8.9 + 2.1; 8.9 + 2.1       | 0.70 + 0.70   | 11.8       |
   | 2, read in the post | 53.0       | 58.0    | 56.2        | 1.8                    | 51.3                        | 8.5 + 2.1                  | 0.69          | 11.2       |
   | 4, read in the post | 49.4       | 56.1    | 52.8, 52.8  | 3.3                    | 46.5, 46.5                  | 8.8 + 2.0; 5.7 + 5.2       | 0.66 + 0.91   | 11.7       |
   | 2, pacer at 120 fps | 52.5       | 59.0    | 58.9        | 0.1                    | 52.3                        | 8.5 + 2.2                  | 0.72          | 11.3       |

   Two values are stream, recording. No variant dropped a frame at a role's queue, as superseded, as stale or at the output, and no frame was torn. The render thread spent 0.00 ms per post in the agent with the read on the capture thread, and 8.4 ms with the read in the post. From a post to the end of its frame's encode took 32 to 38 ms with the read on the capture thread, and 19 to 20 ms in the post. Through the Hub (variants 3 and 4, a WebRTC viewer and the Hub's recording at native size), Chrome drew 48.5 to 49.2 frames per second; the viewer received 54.0 to 54.8 and the recording 54.2 to 54.8, with 45.5 to 46.6 changed frames per second in both; the Hub used 0.06 to 0.07 cores.

   Medium Phone, 720×1600. Chrome drew 60.0 frames per second and the emulator posted 60.0 in every variant, with or without capture. Every role encoded 60.0 frames per second with no drop, and the consumers saw 60.0 changed frames per second; through the Hub, the viewer and the recording had 59.9 to 60.0. A read took 3.2 to 3.4 ms, of which the wait was 2.3 to 2.4 ms. An encode took 5.5 ms for the 432×960 stream, 8.9 ms for 576×1280 and 4.5 ms for the native recording. QEMU used 5.3 cores without a consumer and 6.0 to 6.8 with one or two.

   Controls on another VM of the same type, Pixel 10: Chrome drew 59.7 frames per second without a consumer; 55.3 with every frame read and a 6×16 stream, which needs almost no encode; 55.1 with that read in the post; 52.8 with the 1280 stream; 49.2 with the 1280 stream and the native recording; and 59.7 with the 1280 stream at 30 fps [observed: EAS run `01a1d781-8f08-72df-be85-8b67d1d9cd87`, 2026-11-14].

   What limits the frame rate:
   - Medium Phone: nothing in the capture. The display's 60 Hz does [observed]. So the check that two encodes keep 60 fps at the viewer and in the recording is met for the device that EAS sessions use.
   - Pixel 10: first, the guest draws fewer frames while the agent captures. Reading every frame cost about 4.4 of Chrome's frames per second, in the post or on the capture thread alike, and reading and encoding every second frame cost none [observed: controls]. A likely reason is that each read makes lavapipe finish its queued work: the 1×1 read waits 5.5 to 6.2 ms even for the finished frame of the post before [inferred]. Each encode then cost more frames: about 2.5 for the 1280 stream and 3.6 more for the native recording [observed: controls]. The encoders compete with lavapipe's threads for the CPU: the VM had 13.2 to 13.9 of its 22 vCPUs busy on 11 cores, and lavapipe's threads used 7.0 to 7.4 cores against 7.9 without capture [observed: `/proc`] [inferred: that this contention costs the frames].
   - Pixel 10, second: the agent's 60 fps pacer dropped 1.5 to 2.5 posts per second, with new frames among them: at 60 fps, 1.4 to 2.9 color steps per second skipped one page frame, and at 120 fps almost none. With the pacer at 120 fps, it dropped 0.1 posts per second, and the stream's changed frame rate (52.3) matched Chrome's (52.5) [observed].
   - Pixel 10, not limiting: the encoders took at most 11 ms per frame and never dropped a frame at a queue; the read on the capture thread took the read off the render thread but did not raise Chrome's frame rate, with lavapipe [observed]. The emulator posted 5 to 9 frames per second more than Chrome drew; the consumers got them as repeated frames [observed].

4. **Device end.** Ran 2026-11-13 on the Mac, with a WebRTC viewer. `adb emu kill` during the recording: within two seconds the manifest said `complete` with `stopReason: "device-ended"` (56.2 s, 2932 frames), and a later stop request answered 200 and published it [observed: 2026-11-13].
5. **Two Hubs.** Ran 2026-11-13 on the Mac. A second Hub that streamed the same emulator through the agent replaced only the first Hub's stream consumer; the first Hub moved its stream to gRPC, and its recording went on [observed: 2026-11-13].

## Open questions

- Should the recording repeat the last frame on a still screen, as serve-sim's 60 Hz timer does? The MP4 keeps real frame times, so a still screen is one long frame; repeats only help players that need a constant rate.
- Should the default bit rate scale with the native pixel count? 8 Mbit/s is the tested value at 1080×2424; a 2076×2424 fold canvas has twice the pixels.
