# Emulator GPU frame → FFmpeg NVENC proof

> **DO NOT MERGE — experimental proof of concept.** This branch preserves the experiment and its measured results for review; it is not ready for production integration.

**Measured on the L4: 2160 × 3840 at 119.96 fps, 3,600 encoded frames, zero capture drops or errors.** See [results](results/README.md).

A Linux/NVIDIA experiment with standalone file capture and an opt-in Device Hub live adapter. No emulator rebuild, gRPC screenshot API, or raw-video pipe. Attach only to a disposable emulator: this uses private renderer ABI and native injection.

```text
Posted Android display color buffer (RGBA8 GL texture)
  → wait for renderer GPU work, retain buffer under renderer lock
  → translate emulator texture name to native NVIDIA texture
  → CUDA/OpenGL map
  → GPU-to-GPU copy into one of four FFmpeg CUDA RGB0 frames
  → unmap, wait for CUDA completion, restore EGL context, release renderer lock
  → worker calls FFmpeg h264_nvenc
  → compressed H.264 packets written to a file OR a Unix socket
  → experimental serve-emu adapter → existing Device Hub WebSocket/WebCodecs UI
```

There is one GPU copy. NVENC accepts RGB input and handles the conversion needed by its YUV420 H.264 output. This avoids an application-side RGB→YUV conversion pass; it does not eliminate the encoder's internal conversion or all GPU memory traffic. CPU code schedules work and writes compressed packets.

## Tested stack

- NVIDIA L4, 8 vCPU, 31 GiB RAM, KVM; Ubuntu 26.04.
- NVIDIA open kernel driver 580.178.04, Xorg :99 with an empty NVIDIA screen.
- Android emulator **36.6.11, build 15507667**, Android 36 Google APIs x86_64 image.
- `-no-window -gpu host -feature -Vulkan`; GLES translator backed by NVIDIA L4.
- Private static FFmpeg n8.0.1, nv-codec-headers n13.0.19.0, Frida 17.18.0.
- H.264 NVENC, `p1`, `ull`, zero latency, no B frames, 12 Mbps, four input slots.

The encoder uses its own hidden static FFmpeg symbols because the emulator exports a different bundled FFmpeg. Loading the system shared libraries caused symbol collisions; `RTLD_DEEPBIND` caused allocator conflicts. Build with libc++ to match the renderer's C++ ABI.

## Reproduce on a disposable worker

1. Install Android command-line tools and export `ANDROID_HOME` to that SDK. Accept SDK licenses. Run `bash setup.sh`, then `bash setup-emulator.sh`. The setup checks the emulator version; the native code additionally checks specific instructions before accessing private fields. Do not assume this works on another emulator release.
2. Start the NVIDIA X server: `sudo Xorg :99 -config "$PWD/xorg.conf" -noreset > xorg.log 2>&1 &`. Export `DISPLAY=:99`.
3. Run `bash build-ffmpeg.sh`, `bash build.sh`, and `bash build-animation.sh`.
4. Run `bash launch.sh`. After Android boots, install `animation/build/animation.apk` with `adb -s emulator-5554 install -r animation/build/animation.apk`.
5. Run `bash benchmark.sh 60 720-60`. This waits for boot, launches the animation, measures 20 seconds of display posts without capture, then captures up to 1,800 frames over a 35-second observation window. `sudo` is needed for Frida attach under this worker's ptrace policy.
6. Run `python3 summarize.py 720-60.h264.csv` and `python3 validate.py 720-60.h264`. Use system FFmpeg/ffprobe to decode or mux the output. For the 120 fps raw stream, explicitly supply the input rate: `ffmpeg -nostdin -r 120 -i 4k-120.h264 -c copy -movflags +faststart 4k-120.mp4`. Raw H.264 has no container timestamps; demuxer rate guesses were inconsistent at 120 fps.

Use a **fresh emulator process for every capture**. `bash stop-emulator.sh` stops only the PID matching the experiment’s `gpu_poc` emulator and waits for it to exit. The prototype intentionally keeps its module, registered textures, encoder allocations and shared contexts until process exit. Wait for the process to exit before restarting the same AVD; remove stale AVD lock files only after verifying its emulator has exited. Never overwrite a shared library while an emulator has it mapped.

For portrait 4K, stop the emulator and set `hw.lcd.width=2160` and `hw.lcd.height=3840` in the disposable AVD config. For 120 Hz set `hw.lcd.vsync=120`, launch with `POC_VSYNC=120 bash launch.sh`, then run `bash benchmark.sh 120 4k-120`. The requested rate is not evidence of actual delivered FPS; use capture timestamps and the barcode validation.

## What the measurements mean

`capture_ms` is CPU wall time around acquisition, synchronization, context switching and GPU copy submission/completion. `copy_ms` is CPU wall time around CUDA map, copy, unmap and an explicit stream-completion wait. Neither is a GPU event timestamp, encoder latency, network latency or browser display latency. The explicit wait matters: device-to-device copies do not themselves guarantee host completion ([CUDA synchronization rules](https://docs.nvidia.com/cuda/cuda-driver-api/api-sync-behavior.html)). Exclude the first ten frames from steady-state statistics; first-frame setup initializes CUDA/NVENC and allocates buffers.

Native wrappers count `glReadPixels` and `glGetTexImage` calls through the renderer's GLES dispatch, including calls within the capture callback. Unrelated renderer readbacks can still occur. These counters plus the checked CUDA array→device copy establish the observed capture path; they are not a system-wide PCIe trace and do not enumerate every possible driver-internal operation.

`validate.py` decodes the output **offline** on the CPU and reads a 16-bit frame barcode drawn by the guest app. That validation readback is outside the recording pipeline. Validation gives each decoded picture a synthetic timestamp and uses passthrough output so FFmpeg cannot silently drop pictures when its raw-stream rate guess differs. Correct colors, top/bottom labels, moving geometry and increasing barcodes check that output contains the changing composed display.

## Boundaries

- Single fixed display, fixed resolution and orientation; GL path only. Resolution changes stop capture.
- Hooks internal `FrameBuffer::Impl::postImpl` calls that request locking/context binding. Public wrappers were not reached in this binary's active display path.
- Copies synchronously before returning to the renderer; holds source references and renderer lock while reading. Encoder output retrieval runs separately.
- Buffer queue is bounded and drops capture attempts if no writable input slot is available.
- Private object offsets, dispatch order and function signatures require a matching binary. Small instruction guards are not general ABI compatibility verification.
- Live socket mode supports reconnect, keyframe requests and bounded output; resize/rotation, repeated native capture sessions and production teardown remain unsupported.
- This proves the Linux NVIDIA path. It does not measure Apple Silicon/IOSurface/VideoToolbox.

For product integration, put the hook inside a matching renderer build, expose a supported capture session API, implement teardown and display changes, preserve presentation timestamps, and deliver compressed packets to the existing transport.

## Live Device Hub experiment

Use the same driver, encoder build and disposable emulator setup above. Build the
adapter from the repository root with `bun install --frozen-lockfile`,
`bun run --filter serve-emu setup` and `bun run --filter serve-emu build`.
Run `bash experiments/gpu-frame-poc/install-hub.sh` to install the published
`expo-device-hub@0.10.1` UI and replace only its vendored Android backend with this
checkout's build. This avoids rebuilding the Hub UI and iOS native tools.

From this experiment directory, after boot and APK installation:

```sh
# Use the PID written by launch.sh; start this before opening the Hub.
sudo .venv/bin/python inject.py "$(cat emulator.pid)" \
  --seconds 6000 --frames 100000000 --fps 60 \
  --output unix:/tmp/gpu-live.sock > live-capture.log 2>&1 &
# A first display post initializes the encoder. The interactive fixture also
# exercises tap, text, swipe and fully static screen refresh.
adb -s emulator-5554 shell -n am start -n dev.expo.gpupoc/.LiveActivity
SERVE_EMU_EXPERIMENTAL_GPU_SOCKET=/tmp/gpu-live.sock bash run-hub.sh
# In another shell, using the worker's existing NGROK_AUTHTOKEN:
ngrok http http://127.0.0.1:3400
```

The native module must remain mapped in the emulator for the entire demo. Choose
a fresh socket path on each run. Keep the worker and injector lifetime within the
allocated two-hour window. Restart the emulator before reinjecting native changes.

The private environment override requires an explicit emulator serial and applies
only to that device. The public source setting remains `scrcpy` for compatibility;
`/health.captureBackend` and `experimentalGpuCapture` identify the real video path
as `gfxstream-cuda-nvenc`. scrcpy runs **with video and audio disabled**, for controls
only. Unset both experiment variables to return to normal capture. Settings are
fixed at native resolution, orientation, FPS and 12 Mbps for the demo. Do not use
the stream settings controls to change them while it is active.

The socket carries a 32-byte big-endian header followed by one complete FFmpeg
AVPacket: magic `GPC1`, payload length u32, presentation timestamp in microseconds
u64, flags u32 (0=delta, 1=keyframe, 2=empty handshake), width u32, height u32 and
FPS u32. A client sends `K` to request an IDR. The adapter extracts SPS/PPS and
forwards the existing serve-emu video packet shape, so the browser wire protocol
and input routing do not change. Fragmented or coalesced socket reads do not
change frame boundaries. Invalid, oversized, truncated and changed-size records
fail the session visibly. The adapter waits for configuration plus a keyframe
before reporting startup success.

Only the encoder worker writes to the socket. A stalled receiver is disconnected
after a bounded write wait; existing browser queues handle their own backpressure.
The worker retains the latest CUDA frame and can encode it again for keyframe
requests or a 500 ms idle heartbeat. This keeps a fully static screen joinable
without a GPU→CPU frame transfer. One native socket consumer fans out to multiple
browser viewers through the existing Hub session.
