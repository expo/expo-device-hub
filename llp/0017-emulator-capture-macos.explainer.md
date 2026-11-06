# LLP 0017: Emulator capture on macOS (Apple silicon)

**Type:** Explainer
**Status:** Draft
**Systems:** EmulatorCapture, ServeEmu, Hub, AndroidUtils
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-04
**Revised:** 2026-11-04 (added the EAS macOS VM results); 2026-11-05 (source files moved to a shared C++ layout; rotation); 2026-11-06 (fixes from two deep reviews: replaced record, output limits, touch rotation, install lock, agent log, private socket directory); all by Claude Code, directed by Krystof Woldrich
**Related:** LLP 0000, LLP 0008, LLP 0009, LLP 0016

> File paths in `src/` are relative to `packages/expo-emulator-capture` unless the text names a package.

## Summary

`expo-emulator-capture` captures an Android Emulator's screen on macOS with Apple silicon. An agent library runs inside the emulator's QEMU process. It copies each posted frame into an IOSurface (on the GPU when the emulator renders with the host GPU) and encodes it to H.264 with VideoToolbox, on the hardware encoder when the Mac has one. serve-emu reads the stream from a Unix socket and replaces scrcpy video with it; scrcpy stays the input transport.

The work follows the Linux and NVIDIA experiment in PR #107: the same package name, the same socket framing (GPC1), and the same serve-emu integration shape. Krystof Woldrich asked for a macOS Apple-silicon package that uses the machine's GPU when available and that works with single-screen and foldable emulators, such as the Pixel 9 Pro Fold [confirmed] (Krystof Woldrich, 2026-11-04).

## Loading

The agent is preloaded when the emulator starts, with `DYLD_INSERT_LIBRARIES`, not injected into a running emulator.

- The emulator binaries in 37.2.7 use the hardened runtime, but their entitlements include `com.apple.security.cs.allow-dyld-environment-variables`, `disable-library-validation`, `disable-executable-page-protection` and `get-task-allow` [observed: `codesign -d --entitlements` on `emulator`, `qemu-system-aarch64` and `qemu-system-aarch64-headless`]. So an ad-hoc signed library loads, and Frida Gum can patch the renderer's code.
- Attaching to a running emulator needs `task_for_pid`. On the development Mac, the `system.privilege.taskport` right requires a password from a `_developer` member, and Developer Mode was off [observed: `security authorizationdb read system.privilege.taskport`, `DevToolsSecurity -status`]. Preloading needs no extra permission. Attach is not implemented.
- The `emulator` launcher passes `DYLD_INSERT_LIBRARIES` through to QEMU. A protected system binary in between, such as `/usr/bin/nohup` or `/bin/sh`, removes `DYLD_*` variables, and then the agent does not load [observed: an experiment through `nohup` on 2026-11-04]. The CLI and the Hub spawn the emulator directly.
- The agent runs only in a process named `qemu-system-*`, and it removes itself from `DYLD_INSERT_LIBRARIES` so that QEMU's children (`crashpad_handler`, `netsimd`) do not load it [observed: `src/native/agent.cpp`].
- The socket path comes from `EXPO_EMULATOR_CAPTURE_SOCKET`. The CLI and the Hub name it `<tmpdir>/expo-emulator-capture/<serial>.sock` [observed: `src/paths.mjs`, Hub `src/server/emulator-capture.ts`].
- The socket directory must be a directory that only the user can access (owner and mode 0700); otherwise the agent turns itself off, and the Hub boots the emulator without the agent. A socket that another user owns, or a link, does not count as an agent. A lock file next to the socket (`<socket>.lock`), held for the agent's lifetime, tells a second agent that the socket is served, without a connection that the first agent would take for a new consumer. The log opens without following a symlink [observed: `listen` and `expoEmulatorCaptureInit` in `src/native/agent.cpp`, `ensurePrivateDirectory` in Hub `src/server/emulator-capture.ts`, `emulatorCaptureSocketFor` in serve-emu `src/device-capabilities.ts`].
- An exception must not leave the renderer's thread or the socket thread, because `std::terminate` would end QEMU: both catch them, as the encoder thread does [observed: `onPost`, `serve`].

## Hook point

The agent hooks gfxstream's `FrameBuffer::Impl::postImpl(handle, callback, needLockAndBind, repaint)` with Frida Gum 17.18.0, linked statically [observed: `src/native/agent.cpp`]. All renderer entry points are resolved by name at runtime. The translator EGL functions are local symbols, which Gum resolves from the symbol table [observed: `nm` on `libgfxstream_backend.dylib`; `src/native/gfxstream.cpp`]. A missing required symbol disables capture; missing GPU-path symbols leave only the CPU path.

In the emulator builds tested, every post arrived on one render thread with `needLockAndBind` true [observed: a probe library on 37.2.7, 2026-11-04]. A post with `needLockAndBind` false means that the caller already holds the non-recursive FrameBuffer lock, so the agent skips that frame rather than deadlock [observed: `onPost` in `src/native/agent.cpp`; the same rule as PR #107].

## Frame paths

| Renderer                                                     | How a frame is copied                                                                                                                          | Measured                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `-gpu host` (GLES translator on Apple OpenGL 4.1 over Metal) | The color buffer's native GL texture is blitted into an IOSurface-backed `GL_TEXTURE_RECTANGLE` on a private context shared with the renderer. | 0.11 ms on the render thread per 1080×2424 frame |
| Software (`-gpu auto` headless picks SwANGLE and lavapipe)   | `readColorBufferDeprecated` reads RGBA; vImage converts it to BGRA in an IOSurface pixel buffer.                                               | About 25 ms per 1080×2424 frame; 30–34 FPS       |

[observed: emulator logs `gles_mode_selected:host` and `gles_mode_selected:swangle`; `src/native/frame-source-darwin.mm`; agent stats lines, 2026-11-04]

The GPU path needs host rendering. On a headless Mac, `-gpu auto` selects the software renderer, so the Hub adds `-gpu host` when it boots an emulator with the agent [observed: Hub `src/server/emulator-capture.ts`]. The emulator honors the last `-gpu` flag: with `-gpu auto … -gpu host`, SurfaceFlinger reported the Apple M2 translator [observed: `dumpsys SurfaceFlinger`, 2026-11-04].

The GPU path keeps the image upright with an unflipped blit, because both textures store row 0 first [observed: decoded frames, 2026-11-04].

### Locking

`FrameBuffer::Impl::lock()` and `readColorBufferDeprecated` lock the same mutex [observed: disassembly of both functions in 37.2.7, mutex at `Impl+0x1bc8`]. So the CPU path calls the read without holding the lock. The GPU path holds the lock around its own GL work, as gfxstream's display path does.

## Synchronization

The render thread only submits the GPU copy (`glFlush`). The encoder thread waits for it with a read-only `IOSurfaceLock` before VideoToolbox reads the surface [observed: `src/native/frame-source-darwin.mm`, `waitForGpuCopy` in `src/native/encoder-videotoolbox.mm`].

With `glFinish` on the render thread instead, the guest's render thread spent 1.16 ms per frame in the capture; with the flush it spent 0.11 ms [observed: agent stats, 2026-11-04]. Process CPU comparisons between runs were inconclusive, because the emulator's own CPU use drifted between 60% and 105% over minutes without any consumer [observed: 2026-11-04]. In one time window, per-thread CPU was 8% higher while streaming 1080×2424 at 60 FPS than without a consumer [observed: `ps -M`, 2026-11-04].

## Encoding

A `VTPixelTransferSession` scales the frame and converts it to NV12 with BT.709 terms. A `VTCompressionSession` with `RequireHardwareAcceleratedVideoEncoder` and `EnableLowLatencyRateControl` encodes Constrained Baseline H.264, with a keyframe at least every 10 seconds and on request [observed: `src/native/encoder-videotoolbox.mm`]. Low-latency rate control selects the encoder `com.apple.videotoolbox.videoencoder.h264.rtvc`, which does not answer `UsingHardwareAcceleratedVideoEncoder` (`kVTPropertyNotSupportedErr`). Creation with the hardware requirement succeeded, so the agent reports hardware [observed: a VideoToolbox probe on the M2, 2026-11-04]. When creation with the hardware requirement fails, as on a Mac without a usable hardware encoder, the agent tries low-latency rate control alone and then the default specification, and reports what `UsingHardwareAcceleratedVideoEncoder` answers [observed: `src/native/encoder-videotoolbox.mm`]. Output is converted from length-prefixed NAL units to Annex-B, with SPS and PPS before each IDR.

## Socket protocol

Each record is a 32-byte big-endian header (`GPC1`, payload length u32, pts u64 in microseconds, flags u32, width u32, height u32, fps u32) and a payload [observed: `src/native/protocol.h`, serve-emu `src/gpu-packet.ts`]. The framing is PR #107's GPC1, with a resize record and JSON details added.

| Flags | Record            | Width and height        | Payload                                                                      |
| ----- | ----------------- | ----------------------- | ---------------------------------------------------------------------------- |
| 0     | H.264 access unit | Stream size             | Annex-B                                                                      |
| 1     | IDR access unit   | Stream size             | Annex-B, starting with SPS and PPS                                           |
| 2     | Hello             | Native display size     | JSON: `protocol`, `version`, `platform`, `gpuAvailable`, `renderer`, `posts` |
| 3     | Configured        | Stream size             | JSON: `framePath`, `hardwareEncoder`, `encoder`, `rotation`                  |
| 4     | Resized           | New native display size | Empty                                                                        |
| 5     | Replaced          | 0                       | Empty; a new consumer replaced this one, and the socket closes               |

The consumer sends `K` for a keyframe, `S` and three big-endian u32 values (longest stream edge with 0 for native or 16–4096, FPS 1–120, bit rate 100 kbit/s–50 Mbit/s), or `R` and one big-endian u32 value (Android's display rotation, 0–3). The agent answers `S`, and an `R` that changes the rotation, with a configured record and then an IDR. Hello's `protocol` is 2 when the agent accepts `R` [observed: `src/native/protocol.h`, `readCommands` in `src/native/agent.cpp`].

- After hello, `S`, and configured, frames follow. A resized record is always followed by a configured record and an IDR.
- A consumer that knows the rotation sends `R` before `S`. The agent starts streaming on `S`, so the first session is already upright. A new connection starts at rotation 0.
- One consumer at a time. A new connection replaces the old one; records from an old connection are dropped. Consumers can reconnect without restarting the emulator, which PR #107 could not do. Before it closes the old connection, the agent sends it a replaced record, best effort on the non-blocking socket [observed: `sendReplaced` in `src/native/agent.cpp`].
- On a static screen the renderer posts nothing. When a consumer needs a frame (new settings, `K`), the agent captures the last posted color buffer itself. A frame that the render thread captured meanwhile is older than that frame and is dropped, so timestamps keep increasing [observed: `encoderLoop`].
- Under backpressure (8 MB queued), the agent drops delta frames until the next keyframe, and requests the keyframe once the queue drains to half. Keyframes and control records are never dropped; a consumer whose queue grows past 32 MB stopped reading, and the agent closes it [observed: `sendRecord` and `flushOutput`].
- The encoder thread catches exceptions, so an unexpected size cannot end QEMU through `std::terminate`. The stream size keeps a short edge of at least 2 [observed: `encoderLoop`, `streamSize` in `src/native/protocol.h`].

## Folding and resizes

Folding changes the size of the posted color buffers: 2076×2152 unfolded and 1080×2424 folded on the Pixel 9 Pro Fold profile [observed: capture on 2026-11-04]. When a frame's size differs, the encoder thread re-creates the encoder and sends resized, configured and an IDR [observed: `encoderLoop` in `src/native/agent.cpp`]. serve-emu uses the resized size to map touches, which go to the native display because scrcpy runs without video, as in `grpc-session.ts`. A configured record with a new size becomes a `session` packet, so the middleware resyncs every client from a keyframe [observed: serve-emu `src/gpu-session.ts`, `middleware.ts`].

## Rotation

The color buffer keeps the panel's orientation. When Android turns the screen, it draws the turned picture into the same panel-sized buffer: at display rotation N (`Surface.ROTATION_0` to `ROTATION_270`), the picture is turned N quarter turns clockwise. On 2026-11-04, before this section's change, the Hub showed the stream upside down at 180°, and touches used the panel orientation too [observed: Hub test, 2026-11-04].

The consumer sends the display rotation with `R`. The agent then streams at the upright size (the native edges swap for rotations 1 and 3, before the longest-edge cap), and the VideoToolbox encoder turns each frame N quarter turns counter-clockwise with a `VTPixelRotationSession`, before the `VTPixelTransferSession` scales it [observed: `uprightSize` in `src/native/protocol.h`, `rotate` in `src/native/encoder-videotoolbox.mm`]. The turn runs on the encoder thread, after the wait for the GPU copy, so the guest's render thread does not wait for it. A rotation change re-creates the encoder and sends configured and an IDR, as a fold does. The resized record still reports the native (panel) size.

On the Pixel 10 profile with `-gpu host`, the four display rotations set with `adb shell settings put system user_rotation` gave upright 570×1280, 1280×570, 570×1280 and 1280×570 streams with `--max-size 1280`; the camera cutout appeared at the top, left, bottom and right [observed: `cli.mjs record --rotation`, emulator 37.2.7, 2026-11-05].

serve-emu reads the rotation with `dumpsys window displays` through adb. It reads it before the first settings, so the first session is already upright, then every second for turns that apps start, and after `POST /api/orientation`; a display change during a read starts one more read when it ends [observed: `negotiate`, `refreshRotation` and `displayChanged` in serve-emu `src/gpu-session.ts`]. scrcpy runs without video, so a touch targets the native display: serve-emu maps it to the native size with the edges swapped for rotations 1 and 3 [observed: `uprightTouchSize` in `src/gpu-session.ts`]. The rotation for touches is the one in the agent's last configured record, the rotation of the picture that clients show, because the display turns before the turned picture arrives; `/health` reports the result as `touchSize`. An agent whose hello reports protocol 1 gets no `R`.

## Integration

- **serve-emu.** `emulator-capture` is a third stream mode, with scrcpy as the input transport [observed: `STREAM_MODES` in `src/shared/api-contracts.ts`, `startEmuSession` in `src/stream-session.ts`].
  - The middleware option `emulatorCapture.socketDirectory` names the socket directory. An emulator with a `<serial>.sock` there can use the mode; `/api/stream-mode` lists it in `availableModes`. Otherwise `unavailableModes` gives the reason: `emulatorCapture.unavailableReason` while the feature is off, and `missingAgentReason`, a text or a function of the serial, for an emulator without a socket [observed: `emulatorCaptureAvailability` in `src/device-capabilities.ts`].
  - A request for the mode is exact: without a socket, it fails with the reason, and a socket that nothing answers fails with the missing-agent reason. With `streamMode: "emulator-capture"` as the router default, an emulator without a socket starts with `grpc-screenshot`, and so does one whose socket nothing answers (`GpuCaptureUnavailableError`) [observed: `defaultStreamModeFor` and `getAppUnqueued` in `src/middleware.ts`].
  - When another consumer, such as a second Hub, replaces a session (`GpuCaptureReplacedError`), the router keeps that emulator on `grpc-screenshot` and drops an explicit capture choice for it, until the user selects emulator capture again; that selection takes the agent back. Without this, two Hubs would replace each other in a loop. A capture choice is also dropped when the emulator has no socket any more, for example after a restart without the agent [observed: `noteCaptureTakenOver` and `getAppUnqueued` in `src/middleware.ts`].
  - A physical device gets no reason, so clients show no disabled option for it [observed: `emulatorCaptureAvailability` in `src/device-capabilities.ts`].
  - Only the middleware offers the mode, because it closes a capture session before it opens the replacement, and the agent serves one consumer. The standalone server and CLI refuse it [observed: `updateStreamEncoderSettings` in `middleware.ts`, `startServer` in `server.ts`, `cli.ts`]. `/health` adds `captureBackend` and `experimentalGpuCapture`, which includes the rotation.
- **Hub.** `--experimental-emulator-capture` or `EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE=1` turns the capture on; the Expo CLI plugin has only the variable. The flag sets the variable before the server module loads, so both paths read it the same way [observed: Hub `src/server/cli.ts`, `src/server/emulator-capture.ts`].
  - Krystof Woldrich decided the names, that the capture becomes the default source when it is on, the automatic install, and the text-only hint for emulators without the agent [confirmed: Krystof Woldrich, 2026-11-05].
  - With the capture on, the default Android source is `emulator-capture`, and `--stream-source emulator-capture` is accepted; without it, that value fails with how to turn it on [observed: `defaultAndroidStreamSource` in `src/server/serve-emu-options.ts`, `parseCliOptions` in `src/server/cli/options.ts`].
  - The agent library comes from `EXPO_DEVICE_HUB_EMULATOR_CAPTURE_LIBRARY` (a local build), or from the pinned `expo-emulator-capture` package. The Hub installs that package at start with `npm install --prefix` into `~/.cache/expo-device-hub/tools/expo-emulator-capture/<version>`, through a staging folder, a completion marker and a lock, as T3 Code installs the Hub. The version is the agent package's version in the same release, so a release that changes the agent must release the Hub too; the release workflow checks the changesets for it [observed: `installEmulatorCapture` in `src/server/emulator-capture-install.ts`, `scripts/verify-pending-changesets.ts`]. The lock names its owner's process and has its own token; a lock whose process is gone is taken over at once, and any lock after 11 minutes. A takeover checks that it moved the lock that it judged dead, and a release removes only its own lock [observed: `acquireLock`, `lockIsAbandoned`].
  - A boot waits for the install before it picks a port, so two boots during the install do not get the same port. When the install fails, the emulator starts without the agent, and the boot result says so [observed: `bootAndroidHubDevice` in `src/server/device-actions.ts`]. Every emulator that the Hub boots while the capture is on gets `-gpu host`, with or without the agent. An emulator with the agent also gets the preload, the socket and a log next to the socket (`<serial>.log`). The Hub passes the socket directory to serve-emu, with a reason function that reports the install state, or the agent's own `capture disabled:` reason from that log when the agent turned itself off. While the capture is off, serve-emu gets the turned-off reason instead [observed: `src/server/serve-emu.ts`, `emulatorCaptureMissingAgentReason` in `src/server/emulator-capture.ts`]. `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS` comes after these flags and can override them.
  - On a host that cannot run the capture, the variable only logs a warning, so a shared environment file does not stop the Hub; the stream source select gives the reason [observed: `readEmulatorCapture`].
- **AndroidUtils.** `BootDeviceOptions.env` adds variables to the spawned emulator's environment, and the command that an early exit offers for a manual run includes them [observed: `packages/@expo/hub-android-utils/src/emulator.ts`].

## Known limitations

- Tested only with Android Emulator 37.2.7 (build 16195039) on a Mac mini M2 [observed].
- The EAS macOS VMs (`macos-large`, image `macos-tahoe-26.5-xcode-26.6`, Apple M4 Pro (Virtual), macOS 26.5.2) cannot run the Android Emulator. Hypervisor.framework is not available there (`kern.hv_support: 0`), and emulator 37.2.13 stops with `HVF error: HV_UNSUPPORTED`, also with `-accel off` and with `-qemu -accel tcg`. On the same VMs, the Android SDK installs (command-line tools, platform-tools, the emulator and the API 37 arm64 image in 1 to 2.5 minutes), the agent builds and its tests pass, and the VideoToolbox hardware encoder works: `h264.rtvc` encoded synthetic 1080×2424 frames at 97 to 109 FPS [observed: EAS workflow runs, 2026-11-04].
- In the T3 Code preview browser, the Hub's canvas did not present new frames after a fold or unfold until its layer repainted, although `getImageData` showed the new picture. The same happened with the gRPC source, so it is not specific to this capture [observed: 2026-11-04]. Whether other browsers show it is not known.
- Attach to a running emulator and multi-display capture are not implemented.

## Open questions for the maintainer

- Should the Hub keep `-gpu auto` as the default without the agent, given that it selects the software renderer on a headless Mac? During the app-action script, the emulator used 4.4 cores with `-gpu auto` and 0.6 cores with `-gpu host` [observed: CPU test on the Mac mini M2, 2026-11-05].
