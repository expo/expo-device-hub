# @expo/emulator-capture

> **DO NOT MERGE — experimental, private, and unpublished.** Packaging does not
> make the private renderer ABI or capture lifecycle production-ready.

Attach native FridaInjector + Gum capture to an already-running stock Android
emulator on Linux x64/NVIDIA. Preserve its native display size and VSync while
independently scaling and pacing the encoded H.264 stream. Raw frames remain
on the GPU through capture, scaling, and NVENC input; CPU code handles
coordination and compressed packets.

No emulator rebuild, LD_PRELOAD, Python Frida binding, GumJS agent, or Node
native addon is used. The package provides a CLI and two native artifacts.
The experimental serve-emu adapter remains in its original package.

## Source and generated files

| Path | Purpose |
| --- | --- |
| `src/inject.cpp` | FridaInjector controller; builds `dist/linux-x64/inject` |
| `src/agent-abi.h` | Shared native entrypoint and resident policy |
| `src/gum-agent.cpp` | Gum hooks, entrypoint and lifecycle |
| `src/capture.cpp` | Emulator access, CUDA frame pool and FFmpeg/NVENC worker |
| `src/socket-output.h` | GPC1 video/settings socket |
| `src/stream-format.h` | Resolution calculation and FPS pacing |
| `src/scale.cu` | Hand-written CUDA scaling kernel, compiled to embedded PTX |
| `src/cli.mjs` | Node wrapper that launches and supervises `inject` |
| `scripts/` | Reproducible build, unit test and attach-only benchmark tooling |
| `tests/` | Package/platform and native format/pacing tests |
| `build/` | Ignored generated PTX header and native test executable |
| `dist/linux-x64/` | Ignored build outputs: `inject` and `libgpu_capture.so` |
| `artifacts/benchmarks/` | Ignored benchmark recordings, timing CSVs and summaries |

`gum-agent.cpp`, `capture.cpp`, their headers and the generated CUDA kernel
build `libgpu_capture.so`. The injector loads this adjacent library into the
emulator and stays alive to report status. Encoded video travels directly from
the capture library to its output, without passing through the injector.

Sources, build scripts and deterministic tests belong in Git. Build caches,
compiled binaries and raw benchmark results do not. Built `dist/` artifacts
are intentionally included in an npm tarball even though Git ignores them.
Worker provisioning, driver installation, emulator/fixture management and
workflow integration helpers are maintained outside this repository.

## Build

Build and benchmark helpers use JavaScript and Bun Shell (tested with Bun 1.3.14).
All maintained scripts are `.mjs`; FFmpeg still uses its upstream
configure/Makefile internally.
Package commands invoke their script files directly; `build` runs dependency
setup followed by the three build steps below. Run them from this directory:

```sh
npm run build
npm test
```

Linux x64 build prerequisites: a C/C++ toolchain including Clang, libc++ and
libc++abi development libraries, make, pkg-config, OpenGL/EGL development
headers, Git, curl, tar, xz, Node 18+/npm, and Bun. Prepare these on the host
separately. The build scripts do not install system packages or drivers.
A GPU is required to run capture, not to compile it.

| Script | Role |
| --- | --- |
| `build` | Runs setup, then FFmpeg, scale, and native builds in order |
| `setup:build` | Downloads checksum-verified NVRTC and Frida Core/Gum devkits; fetches nv-codec-headers and FFmpeg source |
| `build:ffmpeg` | Builds restricted static FFmpeg libraries with Clang |
| `build:scale` | Compiles `src/scale.cu` to `build/scale-ptx.h` using Bun FFI/NVRTC |
| `build:native` | Links and strips both native artifacts |

Pinned dependencies: Frida **17.18.0**, FFmpeg **n8.0.1**, nv-codec-headers
**n13.0.19.0**, and build-only NVRTC **12.9.86**. C++17/libc++ matches the
emulator ABI. NVRTC is downloaded directly from NVIDIA, without Python, pip
or a virtual environment. Bun FFI calls NVRTC only to generate the embedded
PTX; neither Bun nor NVRTC is needed by the native capture binaries. The
installed CLI remains compatible with Node 18+.
Use `POC_KEEP_DEBUG=1 npm run build` to retain symbols. FFmpeg reuses its
existing static archives; remove its cache when a rebuild is needed.
FFmpeg defaults to four build jobs; use `POC_BUILD_JOBS=1 npm run build` on
hosts with limited memory.

On macOS, Windows and unsupported architectures, build/setup/native helper
scripts warn and exit successfully before downloads, native tools or FFI
initialization. Bun must be installed to invoke these scripts on any host.
They produce no Linux artifacts. Native tests also skip. The JavaScript CSV summary works
on all platforms.
Capture itself fails explicitly on unsupported hosts. Cross-compilation and
install/postinstall hooks are not provided.

## Capture

The tested target is emulator **36.6.11 / build 15507667**, Linux x64 with
NVIDIA host OpenGL and Vulkan disabled. Prepare and boot the emulator
separately. Other versions may have incompatible private renderer layouts.
The caller must have permission to inject into the target process under the
host's ptrace policy; the package does not elevate privileges automatically.

Replace `12345` with the actual emulator PID:

```sh
npm run capture -- 12345 --count-posts --seconds 10
npm run capture -- 12345 --seconds 600 --frames 100000000 --fps 120 \
  --output unix:/tmp/gpu-live.sock
```

The installed CLI is `emulator-capture`, with the same capture arguments.
An absolute file path instead of `unix:/...` records standalone H.264.
The native controller reports `READY`, `STATUS`, `DONE`, and `ERROR` over a
separate owner-only status socket. The Node wrapper forwards stop signals.

The Hub adapter uses `SERVE_EMU_EXPERIMENTAL_GPU_SOCKET` and
`SERVE_EMU_EXPERIMENTAL_GPU_SERIAL`. It receives native dimensions, requests
encoded max dimension/FPS/bitrate and receives timestamped GPC1 packets.
The socket accepts keyframe requests; gesture coordinates remain native-sized.

## Tests and benchmark

```sh
npm test
# Existing, booted emulator showing continuous animation; PID FPS SECONDS:
npm run benchmark -- 12345 120 30
# Re-evaluate a saved timing CSV:
npm run eval:summarize -- /absolute/capture.h264.csv
```

`npm test` runs the C++ format/pacing test through `test:native`.
This test requires no emulator.

`benchmark` attaches to an existing emulator: it counts posts for 10 seconds,
then captures at the requested FPS for the requested frame count, with a
five-second time allowance. It neither boots nor changes the emulator, and
requires the caller's existing attach permissions. Use an emulator that has
not yet run a capture. Each run writes to a fresh `artifacts/benchmarks/run-*`
directory. On failure, inspect the baseline/capture logs there.

The summary excludes 10 warmup frames and reports measured FPS and CPU wall
timing around capture/CUDA map-copy-unmap. At least 12 frames are required.
It is a capture timing benchmark, not a visual correctness or browser test.

The package was previously compiled, packed, installed and tested on a fresh
NVIDIA L4 worker without a reboot. Pixel 9 stayed at **1080×2424 / 120 Hz**;
stream stages measured approximately **117.5 FPS** native, **29.6 FPS** at
570×1280, **58.9 FPS** at 540×1212, and **117.3 FPS** after restoring native.
All 3,909 received frames decoded with advancing unique fixture barcodes;
the capture audit reported no errors or CPU framebuffer readbacks. Raw
recordings and the fixture-specific workflow tests are kept outside Git.
These measurements precede the JavaScript build-script migration; they are
not a new GPU run.

The JavaScript tooling was validated with Bun 1.3.14 in a Linux x64 container:
both native artifacts built, all eight package tests and the native
resolution/FPS tests passed, and the NVRTC-generated header matched the old
Python output byte for byte. The new CSV summary also matched the saved 4K
capture's Python summary. The container used `POC_BUILD_JOBS=1`; this validation
did not rerun live GPU streaming.

## Experimental limits

- Linux x64 NVIDIA only; macOS/Windows build success means it was skipped.
- Private renderer offsets/symbols with only narrow instruction checks.
- Library remains resident until emulator exit. Baseline counting may precede
  the first capture; a second capture requires an emulator restart.
- Stream resolution/FPS can change; native display resizing, rotation and
  complete resource teardown remain unsupported.
- One native video socket consumer; Hub can fan it out to viewers.
- Stock Frida Core/Gum devkits rather than a custom minimal Frida build.
- Compatible system C++ libraries, NVIDIA drivers and emulator graphics
  configuration remain necessary. Live encoding needs no external FFmpeg CLI.

Nothing has been published; `private: true` prevents npm publication.
