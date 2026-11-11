# LLP 0018: ServeEmu recording of foldables

**Type:** Spec
**Status:** Draft
**Systems:** ServeEmu, HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-11
**Related:** LLP 0001, LLP 0013, LLP 0016

> File paths such as `src/…` are relative to `packages/serve-emu/packages/serve-emu`, unless the text gives a path from the repository root.

## Summary

An Android screen recording of a foldable emulator keeps going when the device folds or unfolds. The recording has one frame size for its whole length, and its `session.json` names the display and the hinge state of every part of the video in a `deviceStates` timeline, in the format of serve-sim's iPhone Duo recordings ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#device-state-metadata)). Fold commands stay available while such a recording runs.

> **Provenance.** Claude Code wrote this draft while it implemented the change. Krystof Woldrich set the direction: track when the device folds and unfolds and which display is recorded, and allow folding, opening and closing while an Android device records [confirmed] (Krystof Woldrich, 2026-11-11). The design choices below are Claude Code's, and human review is pending.

## Problem

Before this change, the recording took the encoded packets of the live stream [observed: `startCaptureReader` in `src/middleware.ts`]. A fold switches the emulator to the other display, which has another size, so the stream's encoder restarts at that size, and the recording failed with "Recording does not support display size changes yet." [observed: `ScreenRecording.accept` in `src/screen-recording.ts`]. A Pixel 9 Pro Fold recording that folded 25 seconds in kept a 28-byte file without frames, and its manifest held only the first frame's `width` and `height` [observed: a local recording on `Pixel_9_Pro_Fold_API_36_1`, 2026-11-11]. HubClient therefore locked the fold controls while a recording ran ([LLP 0016](0016-hub-client-foldable-devices.spec.md#android-emulators)).

## Fold canvas

When the router starts a recording with gRPC capture, it reads the emulator's two displays from the `hardware-qemu.ini` that the emulator writes at launch: `hw.lcd` is the `inner` display, and display region `hw.displayRegion.0.1` is the `outer` display that the closed device shows. A device needs `hw.sensor.hinge` and both sizes [observed: `readFoldableDisplays` in `src/fold.ts`]. The Pixel 9 Pro Fold has a 2076×2152 inner display and a 1080×2424 outer display.

The canvas is the bounding box of the two displays as the gRPC capture gives them: each display fits into the `maxSize`×`maxSize` capture box, and serve-emu crops odd sizes to even. At `--max-dimension 960`, the Pixel 9 Pro Fold's inner display is captured at 926×960 and its outer display at 426×960, so the canvas is 926×960 [observed: `recordingCanvas` in `src/recording-canvas.ts`; the local recording]. The first canvas wins, so a capture that restarts keeps the recording's frame size [observed: `ScreenRecording.foldCanvas`].

Each captured image is centered on the canvas at its own size, or scaled down to fit when it is larger, such as a turned display. Positions and sizes are even, so chroma stays aligned [observed: `placeOnCanvas`]. serve-sim's recorder letterboxes its panels on a fixed canvas in the same way ([LLP 0001](0001-serve-sim-video-pipeline.explainer.md#session-recording)).

The canvas needs both displays' sizes before the first frame, because an MP4 track keeps one size. The bounding box keeps the common case unchanged: a session that starts open records the inner display at the same size as before.

## Recording encoder

The gRPC session encodes the recording with a second encoder, apart from the live stream, so viewers keep each display's own size and touch geometry [observed: `GrpcRecordingEncoder` in `src/grpc-recording-encoder.ts`]. It receives every image that the live encoder accepts, with the same timestamp, and skips an image while its ffmpeg input is busy. It always uses libx264 with the stream's frame rate, bitrate and keyframe interval, and the ffmpeg filter scales the cropped image to its place and pads it to the canvas [observed: `videoFilter` in `src/h264-encoder.ts`].

ffmpeg's raw input has one size per process, so a capture of another size starts a new process with the same settings and canvas. Its first access unit is a keyframe with the same SPS and PPS, so the recording goes on in the same track. The replaced process's last packets hold older frames of the previous display, and the recording drops them [observed: `GrpcRecordingEncoder.#start`; the local recording kept one track and 926×960 for all 524 frames]. A recording encoder failure fails the recording, and the live stream goes on.

The session reports `feedsRecording`, and the router then gives the stream's packets to viewers only [observed: `startCaptureReader`]. scrcpy capture does not encode the fold canvas: its video arrives encoded from the device. A recording with scrcpy capture, or of an emulator whose config this host cannot read, takes the stream's packets as before.

The second encoder costs a libx264 encode at the capture size for as long as a foldable records. Other devices keep the single encode.

## Device-state timeline

Each recorded frame carries its geometry from the recording encoder and the last hinge reading. The manifest's `deviceStates` lists the full state at each change, in the format of [LLP 0001](0001-serve-sim-video-pipeline.explainer.md#device-state-metadata):

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
        "posture": "opened"
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
        "posture": "closed"
      }
    }
  ]
}
```

The top-level `width` and `height` are the canvas. In an entry, `width` and `height` are the shown display's native size, `screen` is `inner` or `outer`, as serve-sim names the iPhone Duo's displays, and `contentRect` is the picture on the canvas in encoded pixels. `hingeAngle` and `posture` come from `adb emu sensor get hinge-angle0` and `cmd device_state base-state`; `posture` is serve-emu's `FoldPosture` [observed: `readFoldState` in `src/fold.ts`].

The screen comes from the captured image: the display whose proportions are closest [observed: `screenForImage`]. The hinge is read when the recording starts, every second while it runs, after each `/api/fold` command, and at once when the recorded display changes, because a fold through adb or another tool does not pass through serve-emu [observed: `pollFold` and `readFoldNow` in `src/middleware.ts`]. A reading that contradicts the shown display, such as `opened` on the outer display, is older than the fold, so that frame leaves `hingeAngle` and `posture` out until the next reading [observed: `poseForGeometry`].

As in serve-sim, a state enters the timeline only after its frame is written, the first entry has `timeMs: 0`, unchanged states are left out, a geometry change keeps the time of its first written frame, a pose-only change waits 250 ms after the previous entry, and the final written state stays [observed: `#recordState` in `src/screen-recording.ts`]. While the recording runs, `session.json` is rewritten at each entry, so a killed process leaves the timeline so far next to its partial file. A recording without the fold canvas has no `deviceStates`.

## Fold during a recording

The recording status that `/api` reports has `followsFold: true` once the gRPC session encodes the fold canvas [observed: `ScreenRecording.snapshot`]. HubClient then leaves the fold commands free: `DeviceFold.unavailable` is absent, and only rotation and stream changes stay locked ([LLP 0013](0013-hub-client-input-and-control.explainer.md#recording-lock)) [observed: `foldRecordingLock` in `packages/@expo/hub-client/src/screen-recording.ts`]. Without `followsFold`, `DeviceFold.unavailable` is the recording lock's reason, and the Hub dashboard disables Fold settings with it [observed: `DeviceOptionsSection.tsx` in `packages/@expo/hub-components/src/dashboard`].

serve-emu also answers `POST /api/fold` with 409 while a recording runs that takes the stream's packets, so a direct API call cannot end it [observed: the `/api/fold` route in `src/middleware.ts`].

## Limits

- Rotation still ends a recording that takes the stream's packets, and HubClient still locks it. A turned foldable on the fold canvas is scaled down to fit, but its timeline has no orientation.
- `posture` and `hingeAngle` lag a fold through adb by up to the time of one reading. The display switch itself is exact, because it comes from the frames.
- The timeline does not name the device model. `deviceName` is the AVD name.
