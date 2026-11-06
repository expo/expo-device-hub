# LLP 0018: Emulator capture on Linux (x86-64)

**Type:** Explainer
**Status:** Draft
**Systems:** EmulatorCapture, ServeEmu, Hub, Release
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-04
**Revised:** 2026-11-06 (x264 build 165 from the system instead of OpenH264; rotation; `-gpu lavapipe`; the EAS emulator step; the release job; fixes from a deep review); all by Claude Code, directed by Krystof Woldrich
**Related:** LLP 0000, LLP 0017

> File paths in `src/` are relative to `packages/expo-emulator-capture` unless the text names a package.

## Summary

`expo-emulator-capture` also runs on Linux x86-64. The agent is the one that [LLP 0017](0017-emulator-capture-macos.explainer.md) describes for macOS: it hooks gfxstream's display post, serves the GPC1 socket protocol with the same records and commands, keeps one consumer, follows folds, and turns the picture upright for the display rotation. On Linux, the agent reads each frame back into memory and encodes it with the x264 library of the host system, build 165. While the capture is on, the Hub boots emulators with `-gpu lavapipe`.

Krystof Woldrich asked for the Linux work in a branch on top of the macOS work. He decided that the agent uses the x264 that the host has installed, as the macOS agent uses VideoToolbox, that it supports only the x264 build that EAS has, and that it fails with the install command elsewhere. He also decided on `-gpu lavapipe`, confirmed with a frame check [confirmed: Krystof Woldrich, 2026-11-05].

## Source layout

The agent core is portable C++: hook, encoder thread, socket server and protocol [observed: `src/native/agent.cpp`, `src/native/protocol.h`]. Each platform supplies a frame source and an H.264 encoder behind two interfaces [observed: `src/native/frame-source.h`, `src/native/encoder.h`]:

| Part         | macOS (LLP 0017)                                | Linux                                                     |
| ------------ | ----------------------------------------------- | --------------------------------------------------------- |
| Preload      | `DYLD_INSERT_LIBRARIES`                         | `LD_PRELOAD`                                              |
| Frame source | GPU copy into IOSurfaces; CPU readback fallback | CPU readback (`frame-source-linux.cpp`)                   |
| Frame memory | `CVPixelBuffer` (`FramePixels`)                 | Pooled RGBA images (`frame.h`)                            |
| Encoder      | VideoToolbox (`encoder-videotoolbox.mm`)        | x264 build 165 from the system (`encoder-x264.cpp`)       |
| Rotation     | `VTPixelRotationSession`                        | Turns of the I420 planes after scaling (`yuv.h`)          |
| Compiler     | `clang++`, libc++                               | `g++` (or `$CXX`), static libstdc++                       |
| Build        | `bun run build`                                 | `bun run build:linux-x64`, with the x264 build 165 header |

## Loading

- The CLI `launch` command and the Hub set `LD_PRELOAD` to the agent, ahead of any library that the caller already preloads [observed: `preloadVariable` in `src/paths.mjs`, Hub `src/server/emulator-capture.ts`]. As on macOS, the agent runs only in a process whose name starts with `qemu-system`, and it removes itself from `LD_PRELOAD` there, so that QEMU's children do not load it. `LD_PRELOAD` entries can be separated by colons or spaces [observed: `removeFromPreload` in `src/native/agent.cpp`].
- The build exports one symbol, `expo_emulator_capture_version`. A version script and `--exclude-libs,ALL` keep Gum, GLib and the static C++ library private: a preloaded library's exports take precedence over the emulator's own symbols. The library needs only `libm`, `libc` and the dynamic loader, and it references no x264 symbol [observed: `scripts/build.mjs`; `nm -D` and `readelf -d` on an EAS build, 2026-11-05].
- `eas/start_android_emulator` passes its step's environment to every program that it starts: `sdkmanager`, `avdmanager`, `adb` and the emulator [observed: eas-cli `startAndroidEmulator.ts`, `AndroidEmulatorUtils.startAsync`]. With the agent in that environment, the agent was mapped in `adb` and in QEMU, only QEMU served the socket, and the step succeeded [observed: EAS run, 2026-11-05]. The package README gives this recipe.

## Frame path

The Linux frame source reads each posted color buffer with `FrameBuffer::readColorBufferDeprecated` into a pooled RGBA image; the encoder converts, scales and turns it [observed: `src/native/frame-source-linux.cpp`]. This works with every gfxstream renderer. The readback runs on the render thread, inside the post, as the macOS CPU path does, so the guest waits for each copy [observed: `onPost` in `src/native/agent.cpp`]. With `-gpu lavapipe`, a copy took 5.9 to 6.9 ms on the EAS VM [observed: agent `stats` lines, EAS runs, 2026-11-05 and 2026-11-06].

The macOS GPU path is not ported, for two reasons:

- The EAS Linux VM has no GPU: `/dev/dri` does not exist [observed: probe on the EAS VM, 2026-11-04].
- The GPU path needs the GLES translator's EGL functions, which are local symbols. The Linux `libgfxstream_backend.so` has no `.symtab`, only a `.gnu_debuglink`, so they cannot be resolved [observed: `readelf -S` and `nm` on emulator 37.1.11].

All the entry points that the CPU path needs are exported in the dynamic symbol table, with the same names as on macOS except one [observed: `nm -D` on emulator 37.1.11]. The exception is `readColorBufferDeprecated`, whose last parameter is a `uint64_t`: it mangles as `unsigned long long` (`y`) on macOS and `unsigned long` (`m`) on Linux. The agent picks the name from the type [observed: `kReadColorBufferDeprecated` in `src/native/gfxstream.cpp`].

## C++ runtime

The renderer is built against the emulator's own libc++: its exports use the `std::__1` namespace, and it needs `libc++.so` from the emulator's `lib64` [observed: `readelf -d` and `nm -D` on emulator 37.1.11]. `FrameBuffer::findColorBuffer` returns a libc++ `std::shared_ptr<ColorBuffer>`. This is the only C++ object that crosses from the renderer into the agent; every other call uses pointers and integers [observed: `src/native/gfxstream.h`].

The Linux agent builds with `g++` and a static libstdc++, so its `std::shared_ptr` does not match. When `_LIBCPP_VERSION` is not defined, `ColorBufferRef` stands in for the libc++ type [observed: `src/native/gfxstream.h`]:

- It has the same layout: the element pointer, then the control block pointer.
- Its destructor is user-provided, so the Itanium C++ ABI returns it through a hidden pointer, as it returns libc++'s `std::shared_ptr`.
- Its destructor calls `std::__1::__shared_weak_count::__release_shared()` from the renderer's libc++, which the emulator's `libc++.so` exports. If the symbol is missing, capture is disabled [observed: `resolveReleaseShared` in `src/native/gfxstream.cpp`].

This keeps `g++`, which the EAS image and most Linux hosts have, as the only compiler requirement. The EAS image has no `clang` [observed: probe on the EAS VM, 2026-11-04].

## Encoder

- **One x264 build.** x264 puts its build number into its library name and into a function name (`libx264.so.165`, `x264_encoder_open_165`), and its interface changes between builds [observed: `x264.h`, build 165]. The agent compiles against the build 165 header and loads `libx264.so.165` with `dlopen` [observed: `src/native/encoder-x264.cpp`]. The Linux build fails with the install command when the header is missing or has another build [observed: `scripts/build.mjs`; EAS run, 2026-11-05]. Ubuntu 26.04 ships build 165 (`libx264-165`); Ubuntu 22.04 and 24.04 ship builds 163 and 164, which do not work. The EAS image `ubuntu-26.04-jdk-17-ndk-r27b-sdk-58` has `libx264-165` 2:0.165.3222+gitb35605ac-3build1 installed, but not the header (`libx264-dev`) [observed: `dpkg -l` on EAS, 2026-11-05].
- **A missing library.** The agent tries to load x264 when a consumer connects and at each session start, and keeps it loaded once it loads. When it does not load, hello carries `encoderError` with the install command, and a failed load is tried again later, so a library that the user installs while the emulator runs works from the next session [observed: `loadX264`, `h264EncoderProblem`; `helloJson` in `src/native/agent.cpp`; EAS run, 2026-11-06]. serve-emu fails such a session with `GpuCaptureEncoderError`: a default capture uses `grpc-screenshot`, and an explicit request fails with the agent's message [observed: serve-emu `src/gpu-session.ts`, `src/middleware.ts`]. Before it boots an emulator, the Hub looks for `libx264.so.165` in `LD_LIBRARY_PATH` and in the usual library directories; when it is missing, the Hub boots without the agent and the stream source select shows the install command [observed: `emulatorCaptureEncoderProblem` in Hub `src/server/emulator-capture.ts`; EAS run, 2026-11-06].
- **Settings.** Preset `ultrafast` with tune `zerolatency` (no lookahead and no B-frames, so each call returns its frame), the baseline profile (the streams decode as Constrained Baseline), average bit rate with a VBV limit at the target rate and a one-second buffer, a keyframe on request and at least every 10 seconds by timestamp (x264's own interval counts frames, and a static screen posts few), SPS and PPS before every keyframe, and BT.709 limited range in the VUI. Threads: a quarter of the CPU cores, at most four, as sliced threads. x264's warnings and errors go to the agent log [observed: `configure` and `encode` in `src/native/encoder-x264.cpp`].
- **Why x264 ultrafast.** In a benchmark on an EAS Linux VM with 240 frames at 1080×2424, x264 ultrafast used 10.0 ms of CPU per frame with four threads, and Cisco OpenH264 2.6.0 used 11.1 ms. On a UI clip at a target of 8 Mbit/s, x264 reached 41.0 dB PSNR at 7.9 Mbit/s, and OpenH264 40.0 dB at 6.1 Mbit/s [observed: encoder benchmark, 2026-11-05]. The earlier Linux branch used Cisco's OpenH264 binary, whose license terms were an open question.
- **License.** x264 is GPL-2.0-or-later. The package does not contain x264 [observed: `package.json` `files`].

## Rotation

At Android's display rotation N, the panel-sized color buffer holds the picture N quarter turns clockwise ([LLP 0017](0017-emulator-capture-macos.explainer.md#rotation)). The x264 encoder scales the RGBA frame into I420 planes in the panel's orientation, then turns the planes N quarter turns counter-clockwise into the upright stream size, in 32×32 tiles [observed: `encode` in `src/native/encoder-x264.cpp`, `rotateI420` in `src/native/yuv.h`]. Turning after scaling moves 1.5 bytes for each stream pixel, not 4 bytes for each native pixel.

- A unit test turns a picture clockwise for each rotation, as the panel holds it, and checks that the turn brings it back upright, also for sizes that are not a multiple of the tile and with padded rows [observed: `tests/yuv.test.cpp`].
- On EAS, for each display rotation set with `adb shell settings put system user_rotation`, the last decoded frame of a capture with that rotation matched `screencap`: a mean difference of 0.9 to 1.2 (of 255) on a 96×43 grayscale thumbnail, and 8.7 to 13.3 for the same frame turned half a turn [observed: EAS runs, 2026-11-05 and 2026-11-06].
- Through the Hub, `POST /api/orientation` with Settings in front turned the display to rotations 1, 2, 3 and 0, and the session's rotation followed each one [observed: EAS run, 2026-11-06]. A phone's launcher stays in portrait, so the display does not turn while the home screen is in front.
- At each of the four rotations, a tap through the Hub's `POST /api/tap` at the Settings search bar, in unit coordinates of the upright display, opened the search [observed: EAS run, 2026-11-06].

## Renderer

While the capture is on, the Hub boots Linux emulators with `-gpu lavapipe`, with or without the agent [observed: `emulatorCaptureArgs` in Hub `src/server/emulator-capture.ts`]. In a renderer sweep on the EAS VM with the readback on the render thread [observed: EAS run, 2026-11-05]:

| `-gpu`        | GLES                              | Vulkan      | Stream FPS | Readback per frame | Emulator CPU |
| ------------- | --------------------------------- | ----------- | ---------- | ------------------ | ------------ |
| `lavapipe`    | ANGLE on lavapipe (Mesa llvmpipe) | lavapipe    | 60.0       | 6.9 ms             | 8.6 cores    |
| `swiftshader` | SwiftShader translator            | SwiftShader | 50.0       | 15.1 ms            | 13.5 cores   |
| `auto`        | SwiftShader translator            | lavapipe    | 30.2       | 13.3 ms            | 10.9 cores   |

With `-gpu auto`, the emulator log says `gles_mode_selected:swangle`, but its adapter line names the SwiftShader translator for GLES [observed: emulator log, EAS run, 2026-11-05].

The frame check records a page that paints each animation frame in the next of eight colors, then reads the color of every decoded frame: a frame with two colors is torn, a step of two colors is one skipped frame, and a step of zero is a repeated frame. With `-gpu lavapipe`, on an emulator that `eas/start_android_emulator` started (Pixel 6 profile, 1080×2400), no frame was torn [observed: EAS runs, 2026-11-05 and 2026-11-06]:

| Run        | Stream    | Frames | Stream FPS | Torn | One color step | Skipped (2) | Repeated (0) |
| ---------- | --------- | ------ | ---------- | ---- | -------------- | ----------- | ------------ |
| 2026-11-05 | 1080×2400 | 533    | 53.4       | 0    | 429            | 28          | 75           |
| 2026-11-05 | 576×1280  | 555    | 55.5       | 0    | 472            | 19          | 63           |
| 2026-11-06 | 1080×2400 | 539    | 54.0       | 0    | 424            | 19          | 95           |
| 2026-11-06 | 576×1280  | 544    | 54.4       | 0    | 445            | 21          | 77           |
| 2026-11-06 | 1080×2400 | 540    | 54.1       | 0    | 446            | 22          | 71           |
| 2026-11-06 | 576×1280  | 550    | 55.1       | 0    | 465            | 22          | 62           |

## Integration

- **Hub.** `--experimental-emulator-capture` also works on `linux-x64`. On Linux, the Hub preloads the agent with `LD_PRELOAD`, adds `-gpu lavapipe`, installs the package's Linux agent (`dist/linux-x64/libexpo_emulator_capture.so`), and checks for x264 before each boot [observed: Hub `src/server/emulator-capture.ts`, `src/server/emulator-capture-install.ts`]. The socket directory is `<tmpdir>/expo-emulator-capture`, as on macOS; on EAS, `TMPDIR` is not set, so it is `/tmp/expo-emulator-capture` [observed: EAS run, 2026-11-05].
- **serve-emu.** The Linux agent needs no other change: the protocol, the rotation reads and the touch mapping are the same as on macOS. An emulator that an EAS step started with the agent became the Hub's default capture source [observed: EAS run, 2026-11-05].

## Release

- The generic `build` task builds only the macOS agent and warns on other hosts, so Linux CI, which builds every package, needs no x264 header. The Linux agent has its own task, `build:linux-x64`, which fails on any other host [observed: `scripts/platform.mjs`, `package.json`].
- The two agents need separate Turborepo cache entries, because the cache key does not include the host. `turbo.json` declares `expo-emulator-capture#build:linux-x64` with `dist/linux-x64/**` as its output [observed: `turbo.json`].
- The release cache workflow has a second job on an Ubuntu 26.04 image. It installs `libx264-dev`, applies the same version steps as the macOS job, and runs only the Linux task with `--force`. The release job restores it, then checks that both agents exist before the version commit [observed: `.eas/workflows/build-release-cache.yml`, `.github/workflows/release.yml`, `scripts/check-dist.mjs`]. This path has not run yet: it needs the production `TURBO_TOKEN` and a release.

## Known limitations

- The readback runs on the render thread, so the guest waits for every copy: 6 to 7 ms per frame with lavapipe on the EAS VM. With SwiftShader, earlier runs had 30 to 50 FPS for that reason [observed: EAS runs, 2026-11-04 and 2026-11-05].
- Tested only on EAS Linux VMs (Ubuntu 26.04, Intel, 22 vCPUs, no GPU) with emulator 37.1.11. A Linux host with a GPU and `-gpu host` is not tested.
- Only x264 build 165. Hosts with another build fail with the install command.
- No hardware encoder: VAAPI and NVENC are not used.
- One socket path serves one emulator. `eas/start_android_emulator` with `count` above 1 starts every emulator with the same environment, so only one of them can serve the socket [inferred: from `listen` in `src/native/agent.cpp`, which refuses a socket that another agent serves; not tested].
- Where `TMPDIR` is not set, all users of a host share `/tmp/expo-emulator-capture`. The agent and the Hub refuse a socket directory that another user owns or can write ([LLP 0017](0017-emulator-capture-macos.explainer.md#loading)), so the first user's directory blocks the others; each user then needs a private `TMPDIR` [observed: `listen` in `src/native/agent.cpp`; README].

## Open questions for the maintainer

- Should the readback move off the render thread? An experiment that copied the frame of the post before reached 59 to 60 FPS with SwiftShader, at the cost of one frame of delay [observed: EAS experiment, 2026-11-04; the code is not in the branch].
- Should the agent name its socket by the console port, so that one EAS step can start several emulators with the agent?
- Should the Linux agent use VAAPI or NVENC, or `-gpu host`, when the host has a GPU?
