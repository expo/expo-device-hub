# LLP 0018: ServeEmu recording of foldables

**Type:** Spec
**Status:** Draft
**Systems:** ServeEmu, HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-11
**Related:** LLP 0001, LLP 0013, LLP 0016

> File paths such as `src/…` are relative to `packages/serve-emu/packages/serve-emu`, unless the text gives a path from the repository root.

## Summary

An Android screen recording of a foldable emulator keeps going when the device folds or unfolds. The recording has one frame size for its whole length, and its `session.json` names the display, the hinge angle and the UI orientation of every part of the video in a `deviceStates` timeline, in the format of serve-sim's iPhone Duo recordings ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#device-state-metadata)). Its keyframes are at most one second apart, as serve-sim's. Fold commands stay available while such a recording runs.

> **Provenance.** Claude Code wrote this draft while it implemented the change. Krystof Woldrich set the direction: track when the device folds and unfolds and which display is recorded, and allow folding, opening and closing while an Android device records [confirmed] (Krystof Woldrich, 2026-11-11). After a comparison with serve-sim, he asked for keyframes as serve-sim's, no `posture` in the timeline because the hinge angle holds it, hinge reads over the emulator's gRPC controller, and `orientation` in the timeline [confirmed] (Krystof Woldrich, 2026-11-12). The design choices below are Claude Code's, and human review is pending.

## Problem

Before this change, the recording took the encoded packets of the live stream [observed: `startCaptureReader` in `src/middleware.ts`]. A fold switches the emulator to the other display, which has another size, so the stream's encoder restarts at that size, and the recording failed with "Recording does not support display size changes yet." [observed: `ScreenRecording.accept` in `src/screen-recording.ts`]. A Pixel 9 Pro Fold recording that folded 25 seconds in kept a 28-byte file without frames, and its manifest held only the first frame's `width` and `height` [observed: a local recording on `Pixel_9_Pro_Fold_API_36_1`, 2026-11-11]. HubClient therefore locked the fold controls while a recording ran ([LLP 0016](0016-hub-client-foldable-devices.spec.md#android-emulators)).

## Fold canvas

When the router starts a recording with gRPC capture, it reads the emulator's two displays from the `hardware-qemu.ini` that the emulator writes at launch: `hw.lcd` is the `inner` display, and display region `hw.displayRegion.0.1` is the `outer` display that the closed device shows. A device needs `hw.sensor.hinge`, both sizes, and `hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture = 1`, the emulator's closed posture [observed: `readFoldableDisplays` in `src/fold.ts`; the Pixel 9 Pro Fold AVD]. A fold-out profile shows its region at another posture, so it keeps the old recording, and HubClient keeps its fold lock; HubClient does not offer fold-out controls either ([LLP 0016](0016-hub-client-foldable-devices.spec.md#android-emulators)). The Pixel 9 Pro Fold has a 2076×2152 inner display and a 1080×2424 outer display.

The canvas is the bounding box of the two displays as the gRPC capture gives them: each display larger than the square capture box is fitted into it, a smaller one keeps its size, and serve-emu crops odd sizes to even [observed: `captureSize`; a 3000 px box gave a 2076×2152 stream on the local Pixel 9 Pro Fold]. The box is `maxSize`. At native size (`maxSize` 0), RGB888 and PNG capture each display at its own size, but MMAP capture sizes its shared memory once from the startup image, so its box is the startup display's longest side; the router names the startup display from the size that `wm size` reports, which also covers rear display mode, where an open device shows its outer display, then from the hinge reading, and counts an unknown one as native size [observed: `captureBox` in `src/recording-canvas.ts`; `createGrpcImageCaptureTransport` in `src/grpc-session.ts`]. At `--max-dimension 960`, the Pixel 9 Pro Fold's inner display is captured at 926×960 and its outer display at 426×960, so the canvas is 926×960 [observed: `recordingCanvas` in `src/recording-canvas.ts`; the local recording]. The first canvas wins, so a capture that restarts keeps the recording's frame size [observed: `ScreenRecording.foldCanvas`].

Each captured image is centered on the canvas at its own size, or scaled down to fit when it is larger, such as a turned display. Positions and sizes are even, so chroma stays aligned [observed: `placeOnCanvas`]. serve-sim's recorder letterboxes its panels on a fixed canvas in the same way ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#session-recording)).

The canvas needs both displays' sizes before the first frame, because an MP4 track keeps one size. The bounding box keeps the common case unchanged: a session that starts open records the inner display at the same size as before.

## Recording encoder

The gRPC session encodes the recording with a second encoder, apart from the live stream, so viewers keep each display's own size and touch geometry [observed: `GrpcRecordingEncoder` in `src/grpc-recording-encoder.ts`]. It receives every image that the live encoder accepts, with the same timestamp, and skips an image while its ffmpeg input is busy. It always uses libx264 with the stream's frame rate and bitrate, and the ffmpeg filter scales the cropped image to its place and pads it to the canvas [observed: `videoFilter` in `src/h264-encoder.ts`].

ffmpeg's raw input has one size per process, so a capture of another size starts a new process with the same settings and canvas. Its first access unit is a keyframe with the same SPS and PPS, so the recording goes on in the same track. The replaced process's last packets hold older frames of the previous display, and the recording drops them [observed: `GrpcRecordingEncoder.#start`; the local recording kept one track and 926×960 for all 524 frames]. A recording encoder failure fails the recording, and the live stream goes on.

The session reports `feedsRecording`, and the router then gives the stream's packets to viewers only [observed: `startCaptureReader`]. scrcpy capture does not encode the fold canvas: its video arrives encoded from the device. A recording with scrcpy capture, or of an emulator whose config this host cannot read, takes the stream's packets as before.

The second encoder costs a libx264 encode at the capture size for as long as a foldable records. Other devices keep the single encode.

### Recording keyframes

The recording's keyframes are at most one second apart, as serve-sim's recorder keeps them at most 60 frames and one second apart ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#keyframe-contract)) [observed: `RECORDING_KEY_FRAME_INTERVAL_S` in `src/grpc-recording-encoder.ts`]. The live stream keeps its own interval. gRPC capture sends an image only when the screen changes, so a count of frames alone does not bound the time: before this change, a 121.8 s recording at the stream's 10 s interval (600 frames at 60 fps) had keyframes at 0, 79.9 and 105.0 s only [observed: a local Pixel 9 Pro Fold recording, 2026-11-12].

The encoder therefore also counts the interval in real time. ffmpeg stamps each frame with the wall clock in microseconds when its filter takes the frame, keeps every frame as one output frame (`-fps_mode passthrough`), and forces a keyframe at the first frame one second after the last forced one, less half a frame of timing jitter; libx264's `keyint` stays 60 frames [observed: `timedKeyFrameArgs` in `src/h264-encoder.ts`]. The output parser pairs access units with the submitted timestamps in order, so one output frame for each input frame keeps that pairing [observed: one access unit for each of 85 frames with pauses and bursts, ffmpeg 9.0.2]. After a pause longer than a second, as on a still screen, the next frame is a keyframe [observed: the real-ffmpeg test in `tests/h264-encoder.test.ts`].

ffmpeg before 5.1 lacks `-fps_mode`, and ffmpeg 9 no longer accepts the older `-vsync`. The session asks ffmpeg once per binary whether it knows these options, and an ffmpeg that does not counts 60 frames only [observed: `createTimedKeyFrameProbe` in `src/h264-encoder.ts`].

A keyframe costs more than a delta frame, about 29 KB against 8 KB on the recording above. With a keyframe each second, a seek decodes at most a second of frames, and a process that stops without finishing the file keeps all but the last fragment, which mediabunny ends at a keyframe at least one second after the previous one (see [Device-state timeline](#device-state-timeline)).

## Device-state timeline

Each recorded frame carries its geometry from the recording encoder and the last hinge and orientation readings from before its capture. A fold canvas frame's PTS is the host monotonic time at which serve-emu submitted its image, and readings keep the time they arrived on the same clock, so a reading that arrives while ffmpeg still holds the frame does not reach it [observed: `#poseAt` in `src/screen-recording.ts`]. The manifest's `deviceStates` lists the full state at each change, in the format of [LLP 0001](0001-serve-sim-video-pipeline.explainer.md#device-state-metadata):

```json
{
  "width": 926,
  "height": 960,
  "deviceStates": [
    {
      "timeMs": 0,
      "state": {
        "width": 2076,
        "height": 2152,
        "screen": "inner",
        "contentRect": { "x": 0, "y": 0, "width": 926, "height": 960 },
        "hingeAngle": 180,
        "orientation": "portrait"
      }
    },
    {
      "timeMs": 27246,
      "state": {
        "width": 1080,
        "height": 2424,
        "screen": "outer",
        "contentRect": { "x": 250, "y": 0, "width": 426, "height": 960 },
        "hingeAngle": 0,
        "orientation": "landscape_left"
      }
    }
  ]
}
```

The top-level `width` and `height` are the canvas. In an entry, `width` and `height` are the shown display's native size, `screen` is `inner` or `outer`, as serve-sim names the iPhone Duo's displays, and `contentRect` is the picture on the canvas in encoded pixels. `hingeAngle` is in degrees. `orientation` is the pose that the UI shows on the panel, with serve-sim's names `portrait`, `landscape_left`, `portrait_upside_down` and `landscape_right`; Android turns the UI inside the same panel image, so `width`, `height` and `contentRect` do not change with it [observed: `getDisplayOrientation` in `src/adb.ts`; the local recording]. An unknown field is absent.

The entries have no posture. The emulator derives its posture from the hinge angle by the profile's ranges, such as `hw.sensor.hinge_angles_posture_definitions = 0-30, 30-150, 150-180` for closed, half opened and opened on the Pixel 9 Pro Fold, so `hingeAngle` holds the same information [observed: the Pixel 9 Pro Fold AVD's `hardware-qemu.ini`]. serve-sim's entries have no posture either.

The screen comes from the captured image: the display whose proportions are closest [observed: `screenForImage`]. The emulator shows the outer display at the closed posture's angles, which serve-emu reads from `hw.sensor.posture_list` and `hw.sensor.hinge_angles_posture_definitions` [observed: `parseFoldableDisplays` in `src/fold.ts`]. A hinge reading that contradicts the shown display, such as 180° on the outer display, comes from the other side of a fold that the frames do not show yet, or already show, so that frame leaves `hingeAngle` out until a reading agrees; `orientation` stays [observed: `poseForGeometry`]. A profile without those ranges keeps every reading.

#### Hinge readings

The emulator has no hinge angle stream: `streamPhysicalModel` and `streamSensor` return gRPC status 12, `UNIMPLEMENTED`, on emulator 36.6.11. `getPhysicalModel` with `HINGE_ANGLE0` answers in about 0.25 ms, against about 45 ms for the two adb commands that the recording used before, and `streamNotification` pushes a `Posture` message each time the emulator's posture changes [observed: a local probe of the Pixel 9 Pro Fold emulator, 2026-11-12]. A fold through adb, agent-device or the emulator's own controls does not pass through serve-emu, so the recording reads the hinge itself.

While a foldable records, serve-emu reads the angle over gRPC every 100 ms, as serve-sim's hinge monitor asks for 100 ms updates ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#device-state-metadata)), keeps the posture stream open, and reads at once when a posture change arrives, after each `/api/fold` command, and when the recorded display changes [observed: `startFoldRecordingFeed` in `src/fold-recording-feed.ts`; `readFoldNow` in `src/middleware.ts`]. In the local probe, each pushed change came 0–90 ms before the next 100 ms read. Each read also takes the orientation from the device state's reader, which a rotation through `/api/orientation` sets at once and which reads adb in the background when its value is older than a second [observed: `createDisplayOrientationReader` in `src/display-orientation.ts`]. Only a change adds a reading to the history that frames look up.

When the recording starts, serve-emu reads the hinge and posture over adb and the orientation once; the posture names the startup display for native-size MMAP capture. Until the gRPC endpoint opens, and after a gRPC read fails, the feed reads the hinge over adb every second [observed: `readHingeOverAdb` and `ADB_HINGE_READ_MS`]. A read or a timer is always pending, so the feed sees a recording that ends within one interval; it then stops and closes the gRPC client with its posture stream, also when the live stream goes on [observed: `running` in `src/fold-recording-feed.ts`].

As in serve-sim, a state enters the timeline only after the muxer accepts its frame, the first entry has `timeMs: 0`, unchanged states are left out, a change of the display or the orientation keeps the time of its first accepted frame, a hinge-only change waits 250 ms after the previous entry, and the final state stays [observed: `#recordState` in `src/screen-recording.ts`]. The fragmented MP4 writes a fragment only when the next one starts, at a keyframe at least one second later, so an accepted frame can still be missing from the file. While the recording runs, `session.json` is therefore rewritten whenever a finished fragment brings more entries into the file, and it lists only those, compared by each frame's exact sample time rather than the rounded `timeMs`; a killed process leaves the timeline of the frames in its partial file. The complete manifest lists every entry [observed: `persistedUntil` from mediabunny's `onMoof` in `createMp4Writer`, `#statesInFile` and `#publishStates`]. A recording without the fold canvas has no `deviceStates`.

## Fold during a recording

The recording status that `/api` reports has `followsFold: true` once the gRPC session encodes the fold canvas [observed: `ScreenRecording.snapshot`]. HubClient then leaves the fold commands free: `DeviceFold.unavailable` is absent, and only rotation and stream changes stay locked ([LLP 0013](0013-hub-client-input-and-control.explainer.md#recording-lock)) [observed: `foldRecordingLock` in `packages/@expo/hub-client/src/screen-recording.ts`]. Without `followsFold`, `DeviceFold.unavailable` is the recording lock's reason, and the Hub dashboard disables Fold settings with it [observed: `DeviceOptionsSection.tsx` in `packages/@expo/hub-components/src/dashboard`].

serve-emu also answers `POST /api/fold` with 409 while a recording runs that takes the stream's packets, so a direct API call cannot end it [observed: the `/api/fold` route in `src/middleware.ts`].

## Limits

- Rotation still ends a recording that takes the stream's packets, and HubClient still locks it during every recording.
- `hingeAngle` lags a fold by up to 100 ms, or a second when the feed reads over adb. A rotation from outside serve-emu reaches `orientation` up to about a second late. The display switch itself is exact, because it comes from the frames.
- Timed keyframes use the time at which ffmpeg's filter takes each frame, not its capture time. ffmpeg takes a frame within milliseconds unless its input is busy.
- In Android's rear display mode, an open device shows its outer display. Its hinge angle then contradicts the shown display, so those entries leave `hingeAngle` out.
- The timeline has no `physicalOrientation` or `tableMode`, which serve-sim reads from Apple's motion stream. The emulator's gRPC controller has no such stream.
- The timeline does not name the device model. `deviceName` is the AVD name.
