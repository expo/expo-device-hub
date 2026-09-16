# @expo/emulator-capture

Experimental Android emulator capture, aiming for a high-performance pipeline that enables **4K video streams at 120 FPS and beyond** on supported hardware. The project currently focuses exclusively on **x86-64 Linux with NVIDIA GPUs**.

Used in [Expo Device Hub](../../expo-device-hub).

## Capture

With a supported Android emulator already running, replace `12345` with the emulator's host process ID:

```sh
npx @expo/emulator-capture 12345 --fps 120 --output /tmp/capture.h264
```

This records an H.264 video stream. Use `--output unix:/tmp/capture.sock` to send framed H.264 packets to a socket consumer instead.

## How it works

FridaInjector loads a native library into an already-running, stock emulator, and Frida Gum hooks its graphics renderer. CUDA handles frame transfer and scaling on the GPU; bundled FFmpeg libraries feed NVIDIA's NVENC hardware encoder. Raw frames stay on the GPU, while the CPU handles coordination and encoded packets. No emulator rebuild or external FFmpeg executable is needed.

The pipeline preserves the emulator's native resolution and VSync. Socket consumers can request a lower stream resolution and frame rate independently.

**Injection is experimental:** it relies on private renderer internals and requires permission to attach to the emulator process. The current reference is Android Emulator **36.6.11 / build 15507667**, using NVIDIA host OpenGL with Vulkan disabled; other emulator versions may be incompatible. The library stays loaded until the emulator exits, and starting a second capture currently requires an emulator restart. Rotation and native display resizing are not supported yet.

## Build and test

Run from this package directory on Linux x86-64. Install Bun, Node.js 18+/npm, Clang, libc++/libc++abi development libraries, make, pkg-config, OpenGL/EGL development headers. Capture also needs a working NVIDIA driver; building and unit tests do not require a GPU.

```sh
npm run build
npm test
```

By default, setup downloads the upstream FFmpeg `n8.0.1` source. It preserves an existing `ffmpeg-source/` directory, so you can edit those sources or supply a compatible replacement before building:

```sh
npm run setup:build
# Apply your FFmpeg changes in ffmpeg-source/.
npm run build
```

Each build configures FFmpeg with our CUDA/NVENC options, runs make to pick up source changes, and statically links the resulting libraries into `libgpu_capture.so`. Existing archives do not skip the build. Restart the emulator before using a replacement capture library if one is already injected.

## Benchmark

Start an emulator showing continuous animation, using a fresh emulator process if it has already run a capture. From the package directory, pass its host PID, target FPS, and capture duration in seconds:

```sh
npm run benchmark -- 12345 120 30
```

The benchmark first measures a baseline, then records video and capture timing. Logs, recordings, timing CSVs, and a JSON summary go into `artifacts/benchmarks/run-*`. It measures capture performance, not browser playback or end-to-end visual correctness.

## Licenses

Original Expo source, including the injected capture code and injector, is [MIT-licensed](LICENSE). The native binaries include FFmpeg, Frida, and other components under separate licenses. See the [preliminary third-party inventory](THIRD_PARTY_LICENSES.md) and [upstream license copies](LICENSES/README.md). Final artifact attribution and source/rebuild distribution still need verification before release.
