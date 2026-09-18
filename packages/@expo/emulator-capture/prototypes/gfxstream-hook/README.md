# Standalone gfxstream injection prototype

This disposable experiment asks whether the same native injection mechanism and
`gfxstream::host::FrameBuffer::Impl::postImpl` hook can run against a standalone
gfxstream application without QEMU or the Android Emulator.

It builds upstream gfxstream in `BUILD_STANDALONE=ON`, `CONFIG_AEMU=OFF` mode.
A small host creates a real color buffer and posts frames. The existing Expo
injector loads a small Gum agent into that already-running host; the agent counts
calls to the upstream implementation. The demo agent has no capture, CUDA, or
FFmpeg code. It does not replace gfxstream with a mock.

## Run

From the repository root, on macOS or Linux with Docker:

```sh
packages/@expo/emulator-capture/prototypes/gfxstream-hook/run-demo.sh --docker
```

The container uses the Docker host's native architecture (arm64 or x86_64), with
matching Frida devkits. `SYS_PTRACE` is added only to that disposable container
for cross-process injection. Default seccomp remains enabled. The first run
downloads inputs and builds the renderer; later runs reuse the inputs and build.

On native Linux, install the packages listed in [Dockerfile](Dockerfile) and run:

```sh
packages/@expo/emulator-capture/prototypes/gfxstream-hook/run-demo.sh
```

The native injector needs permission to trace the demo host. If the local ptrace
policy prevents this, use the Docker command above; this script does not change
the machine's ptrace policy.

The upstream renderer still identifies itself in logs as `Android Emulator
OpenGL ES Translator`. That is gfxstream's built-in renderer name; this demo's
process is `gfxstream-demo-host`, and no Android Emulator executable is involved.

Use `--phase build` or `--phase run` to separate compilation and execution.
`DEMO_JOBS=1` reduces peak compiler memory. On native Linux, optional
`GFXSTREAM_SOURCE_DIR`, `FRIDA_CORE_DEVKIT_DIR`, and `FRIDA_GUM_DEVKIT_DIR` override
individual inputs. Modified inputs must use explicit directory overrides;
default caches are checked against the pinned archives. `DEMO_WORK_DIR` changes
the local work/output directory. Docker's convenience wrapper uses paths inside
the mounted package and its default input directories.

## What the injection does

1. `gfxstream-demo-host` starts and loads the locally built renderer.
2. The same [`src/inject.cpp`](../../src/inject.cpp) used by the capture experiment
   calls `frida_injector_inject_library_file_sync` with the host PID and the demo
   agent's path. Frida loads the library and invokes `poc_agent_main` inside the
   target process.
3. The agent finds `libgfxstream_backend.so`, resolves the real exported
   `FrameBuffer::Impl::postImpl` implementation, and attaches a Gum callback.
4. Posting a color buffer executes that implementation and increments the hook
   counter. The agent reports counts over the existing Unix socket protocol and
   detaches its callback when the measurement ends.

## Evidence and interpretation

Verified on 2026-09-17 in native Linux ARM64 Docker with default seccomp and
container-scoped `SYS_PTRACE`. Upstream gfxstream compiled without source changes.
The host passed a 64×64 RGBA upload/readback comparison and exited cleanly after
posting frames. The agent was absent from the initial process mappings and
present during measurement. Both live runs observed **58 calls to the actual
`FrameBuffer::Impl::postImpl`**, with zero reported hook errors. The second run
used the documented Docker wrapper. Linux x86_64 is supported by the input
selection but has not been executed for this prototype.

Generated files live under `packages/@expo/emulator-capture/artifacts/gfxstream-hook/`:

```text
inputs.json                 pinned input URLs, hashes, and directory overrides
gfxstream/                  upstream source with its license notices
frida-{core,gum}-ARCH/       matching official Frida devkits
build-ARCH/                 renderer, host, hook agent, and injector
evidence/
  host.log                  real buffer/post activity
  injection.log             READY, hook counts, and DONE
  maps-before-injection.txt host's loaded mappings before injection
  maps-during-hook.txt       mappings while the agent is active
  *-dynamic.txt             ELF dynamic dependency information
  result.json               positive hook count, binary hashes, and outcome
```

The runner requires a positive count, a renderer loaded from this standalone
build, successful injector completion, and a clean host exit. It records runtime
mappings and rejects mapped libraries named for QEMU, Android Emulator, or the
FFmpeg/x264 dependencies checked by the script. Library-name checks supplement
the source/build evidence; they cannot detect every possible statically included
component.

A passing run demonstrates that this injection mechanism and hook work in a
technically independent gfxstream application. That is useful evidence when
evaluating a narrower integration boundary. It does **not**, by itself, determine
the legal scope of the different renderer shipped in Google's emulator, which
contains additional dependencies. See the [source/license boundary research](../../docs/gfxstream-hook-source-boundary.md).

Original demo code is MIT under [the package license](../../LICENSE). Upstream
gfxstream and Frida retain their own licenses and dependency notices. This demo
uses official prebuilt Frida devkits to keep the experiment small; it is not a
replacement for the separate corresponding-source and dependency compliance
work on the release binaries.
