# LLP 0026: Device audio input: in-app injection on iOS, injectAudio on Android

**Type:** Decision
**Status:** Draft
**Systems:** ServeSim, ServeEmu, AndroidUtils, CI
**Author:** Eric Dauenhauer (with Claude Code)
**Date:** 2026-11-24
**Related:** LLP 0007, LLP 0011, LLP 0014

> File paths such as `src/…` are relative to the package that the text names. Paths from the repository root start with `packages/`.

## Summary

A customer sends audio into a hosted device, and the app's recorder hears it. The source is an audio file or the viewer's browser microphone. A physical microphone on the host is never a source.

- **iOS Simulator: in-app injection.** A startup capability dylib (`SimMicInjector`), loaded by the capability loader (LLP 0007), gives the app's audio I/O a fake input stream that carries our audio. It uses dyld `__interpose`. It needs no change to the VM image, no driver, and no root.
- **Android emulator: gRPC `EmulatorController.injectAudio`.** This is the emulator's own microphone API. serve-emu keeps one real-time stream open for each emulator session.
- **Both platforms:** serve-sim and serve-emu write the source into the device. When no source plays, the app records silence.

We optimize for low attention cost: the simplest mechanism that is proven to work, all inside the packages that we release, and in the same pattern that serve-sim already uses for the camera.

## Context

- **Recording fails today on EAS iOS.** The EAS macOS VM has no audio input device. Its only device is "Apple Virtual Sound Device", with 2 output channels and no default input. Without a fix, every recording API fails. `expo-audio` throws "Failed to prepare recorder", because `prepareToRecord` returns `NO` for its AAC preset.
- **The `AVAudioSession` layer already reports a microphone.** With no input device, the Simulator's session still reports `inputAvailable=1` and `MicrophoneBuiltIn`. The failure is lower, in the HAL I/O layer.
- **Android emulators start without audio.** build-tools starts the emulator with `-noaudio` ([`eas-cli AndroidEmulatorUtils.ts`](https://github.com/expo/eas-cli/blob/d16d5695d7dce7d2a8b8345d11d6e05775a4e88f/packages/build-tools/src/utils/AndroidEmulatorUtils.ts#L385)), and Device Hub starts it with `-no-audio` ([`@expo/hub-android-utils emulator.ts`](https://github.com/expo/expo-device-hub/blob/69d7e135a3957d8e337b530cf8c09a7ecd12eeb9/packages/%40expo/hub-android-utils/src/emulator.ts#L31)). With that flag, injected audio is dropped with no error.

## Options considered for iOS

Two spikes used the same shared-memory ring and the same feeder process on the host. Only the delivery to the app was different.

### Option A: in-app injection (chosen)

In the Simulator, the app process runs its own copy of the media server. That server does all device I/O through one HAL client IOProc on one aggregate device. A dylib in the app hooks 11 HAL client functions (`AudioObjectGetPropertyData` and others, `AudioDeviceCreateIOProcID`). It adds an input stream to the output-only devices, and it gives the IOProc an input buffer with audio from the ring.

Results of the spike:

- On both EAS images (iOS 26.5 and iOS 27.0), with no input device: `AVAudioRecorder` (PCM and the AAC preset of `expo-audio`), `AVAudioEngine`, RemoteIO, VoiceProcessingIO, and AudioQueue record a 1000 Hz tone at the correct frequency and level (−9 dB). Without the dylib, all of them fail.
- With no feeder, the app records exact silence (−200 dB), with no error.
- The faked HAL properties are the same on iOS 26.5, 27.0, and 27.2.
- A device-wide insert with the real capability loader ran for 5 minutes on iOS 27.2 with no crash from the dylib, and the fixture recorded the tone.
- `AVCaptureSession` audio is not known. The test app gets no audio from it even with a real microphone and no dylib, so this result does not test Option A (see Open questions).
- About 770 lines of C with `__interpose`. The dylib links libSystem only.

### Option B: our own virtual input device (fallback)

An input-only AudioServerPlugIn (about 200 lines on libASPL) runs in `coreaudiod`. The Simulator records from the Mac's default input, which is this device.

Results of the spike on a Mac and in a clean macOS 26.6.2 Tart VM: `AVAudioRecorder` and `AVAudioEngine` record the file audio. The Simulator follows a change of the default input during a recording. It survived restarts, a cold boot, and a 20-minute soak. It was not tested on an EAS image.

BlackHole was the first candidate for Option B. We rejected it because of its license (GPL-3.0, with a separate license for other projects). Our own driver did the same work.

### Comparison

| Criterion          | Option A                                                                                                 | Option B                                                                                                                                                                                  | Better |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Attention cost     | All work in serve-sim, shipped through npm. No other team. A check on each new Simulator runtime.        | One-time work to update the VM image: driver install, signing, root. Driver version is fixed per image, serve-sim is not, so serve-sim must support every driver version in a live image. | A      |
| Implementation     | More code, and the hooks run in every process that loads the dylib.                                      | Less code, public API.                                                                                                                                                                    | B      |
| Maintenance        | One artifact: dylib and feeder ship together.                                                            | Two artifacts with separate release paths.                                                                                                                                                | A      |
| Stability          | Depends on private Simulator internals.                                                                  | Public API, stable once installed.                                                                                                                                                        | B      |
| Fit with serve-sim | Same pattern as the camera: capability loader, capability dylib, shared memory named in an env variable. | A new kind of artifact (a system driver in the VM image).                                                                                                                                 | A      |
| Developer's Mac    | Works with no install, and does not change the Mac's default input.                                      | Needs a root install, and changes the Mac-wide default input.                                                                                                                             | A      |

## Decision

**iOS: Option A, in-app injection. Option B stays the documented fallback**.

Reasons:

1. **Attention cost.** Option A needs no VM image change, no signing, no root, and no other team. The owner and lead time of a VM image change are not known.
2. **Fit.** Option A is the pattern that serve-sim already uses for the camera (LLP 0007).
3. **The risk is one that serve-sim already carries and tests for.** serve-sim already depends on private Simulator internals, and its CI runs on the same two images and runtimes where Option A passed (LLP 0014). A mic e2e test there turns "fails silently on a new runtime" into "a CI failure before release".
4. **The choice can be reversed.** The host side (sources, feeder, ring, browser transport) is the same for both options. Only the delivery changes.

**Android: `injectAudio`** over serve-emu's gRPC connection to the emulator. It works locally and on the EAS Linux image `ubuntu-26.04-jdk-17-ndk-r27b-sdk-58` without PulseAudio. No other option was needed.

## Rules

### iOS

1. **Startup capability, armed at session start.** The hooks must be in place before the app starts audio. So the mic is a `startup` capability (LLP 0007 [Startup capabilities](0007-serve-sim-capability-loader.explainer.md#startup-capabilities)), and serve-sim arms it device-wide at the start of every session. A customer then never needs an app restart to use the mic. An app that started before the capability was armed does not hear injected audio until it restarts.
2. **`__interpose`, with pass-through when off.** dyld applies `__interpose` in every process that loads the dylib, also where the loader never initializes the capability. The hooks must call the real functions, and log nothing, in those processes. A build that does not do this will crash. We use `__interpose`, not patching of the shared cache's GOT slots: both gave the same results on both EAS images, and `__interpose` needs no stub decoding.
3. **No source = silence.** With no feeder, the dylib gives silence. The app must never fail to record because of a missing source.
4. **Fake or replace, from the selected device.** If the input device that the Simulator selected has no input stream (EAS), the dylib fakes one. If it has one (a developer's Mac with a microphone), the dylib replaces its data. The spike decided this from "any input device on the host", which is wrong when the Simulator selected an output-only device. Production code decides from the selected device.
5. **Drop stale data.** When the app turns its input stream on, the dylib drops old ring data. Without this, up to 100 ms of old audio played at the start of a recording.
6. **Do not touch the host.** No default-input change, no driver, no root. Each session has its own ring, named in `SIMMIC_SHM_NAME`, like `SIMCAM_SHM_NAME` for the camera.
7. **Visible failure.** The dylib reports if its hooks installed and if the media server read its fake properties, so that serve-sim can log or show an error on a runtime where the hooks do not work.

### Android

1. **Start the emulator with audio.** Remove `-noaudio` for device-session emulators only. Builds, Maestro, and other test runs keep it.
2. **Open the stream about 2 s after an app starts to record.** serve-emu detects recording with `adb shell dumpsys media.audio_policy` (an `AudioRecord` client with `State: Active` and `AUDIO_SOURCE_MIC`). A stream that opened with no recording, or too soon after it started, crashed the emulator (`audio_forwarder_enable` SIGSEGV). Adding a 2 s wait fixed it. The first 2 s of the first recording in a session are lost.
3. **One stream per emulator session, never closed while nothing records.** After a stream ends with no recording, every later stream records silence or hangs until the emulator restarts. So serve-emu keeps one stream open, and sends silence while an app records and there is no source.
4. **Write only while an app records.** While the stream is open and nothing records, serve-emu sends no packets. It polls the recording state and starts to write again when an app records, with no new wait. Realtime packets that nothing reads made the next recording noise `[observed: 2026-11-24, API 37, emulator 37.2.13, one run with serve-emu's injector and one with the CoinFlip script]`. With no packets while nothing records, the second recording was a clean tone in two runs `[observed]`.
5. **`MODE_REAL_TIME`, paced by serve-emu**, at most about 100 ms ahead. In the default mode, the stream blocks when the app stops recording, and the client hangs.
6. **Format:** mono, 16-bit PCM, 44.1 kHz. The guest records at 44100 Hz.

These Android rules come from a small number of local runs and one Linux run. They must be repeated on the Linux image before serve-emu ships the feature.

## Consequences

- **CI gate (required before release).** A mic e2e test runs on every supported Simulator runtime (today iOS 26.5 and iOS 27.0, LLP 0014). It records a known tone and checks the frequency and level. A failure blocks the release. Adding a runtime to LLP 0014 adds it to this test.
- **Before Option A ships:** a device-wide insert test on both EAS images (done locally on iOS 27.2 only); interruption, route change, and background tests; a test on iOS 27.1 with a device type that the runtime accepts.
- **Each new Xcode or Simulator runtime** can need a fix to the dylib. This is the recurring cost that we accept.
- **Browser microphone transport** is not decided here. The candidate is PCM from an AudioWorklet over the existing WebSocket, the same for both platforms. The preview iframe needs `microphone` in its `allow` list.
- **Out of scope:** device audio output to the browser ("hear the app"). Neither serve-sim nor serve-emu sends device audio today: serve-sim's WebRTC sends video only, and serve-emu runs scrcpy with `audio=false`.

## When to switch iOS to Option B

Switch the delivery to our own driver if a new runtime moves the media server out of the app process or changes the HAL path, and a fix is not quick. The host side does not change. Option B then needs the driver in the macOS VM images, signing, and a version rule between the driver and serve-sim.

## Open questions

- What happens when serve-emu restarts while its stream is open? This needs a test and a recovery plan.
- Does `AVCaptureSession` audio work with Option A? Not known. The spike's test app gets no audio from `AVCaptureSession` even with a real microphone and no dylib, so its result tells us nothing. Fix the test app first, then test again.
