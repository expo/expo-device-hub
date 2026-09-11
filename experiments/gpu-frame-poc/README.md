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

Use a **fresh emulator process for every capture**. `bash stop-emulator.sh` stops only the PID matching `POC_AVD` (default `gpu_poc`) and waits for it to exit. The prototype intentionally keeps its module, registered textures, encoder allocations and shared contexts until process exit. Wait for the process to exit before restarting the same AVD; remove stale AVD lock files only after verifying its emulator has exited. Never overwrite a shared library while an emulator has it mapped.

For portrait 4K, stop the emulator and set `hw.lcd.width=2160` and `hw.lcd.height=3840` in the disposable AVD config. For 120 Hz set `hw.lcd.vsync=120`, launch with `POC_VSYNC=120 bash launch.sh`, then run `bash benchmark.sh 120 4k-120`. The requested rate is not evidence of actual delivered FPS; use capture timestamps and the barcode validation.

## What the measurements mean

`capture_ms` is CPU wall time around acquisition, synchronization, context switching and GPU copy submission/completion. `copy_ms` is CPU wall time around CUDA map, copy, unmap and an explicit stream-completion wait. Neither is a GPU event timestamp, encoder latency, network latency or browser display latency. The explicit wait matters: device-to-device copies do not themselves guarantee host completion ([CUDA synchronization rules](https://docs.nvidia.com/cuda/cuda-driver-api/api-sync-behavior.html)). Exclude the first ten frames from steady-state statistics; first-frame setup initializes CUDA/NVENC and allocates buffers.

Native wrappers count `glReadPixels` and `glGetTexImage` calls through the renderer's GLES dispatch, including calls within the capture callback. Unrelated renderer readbacks can still occur. These counters plus the checked CUDA array→device copy establish the observed capture path; they are not a system-wide PCIe trace and do not enumerate every possible driver-internal operation.

`validate.py` decodes the output **offline** on the CPU and reads a 16-bit frame barcode drawn by the guest app. That validation readback is outside the recording pipeline. Validation gives each decoded picture a synthetic timestamp and uses passthrough output so FFmpeg cannot silently drop pictures when its raw-stream rate guess differs. Correct colors, top/bottom labels, moving geometry and increasing barcodes check that output contains the changing composed display.

## Boundaries

- Single fixed native display and orientation; GL path only. Changing the emulator display resolution still stops capture; encoded stream resizing is supported.
- Hooks internal `FrameBuffer::Impl::postImpl` calls that request locking/context binding. Public wrappers were not reached in this binary's active display path.
- Copies synchronously before returning to the renderer; holds source references and renderer lock while reading. Encoder output retrieval runs separately.
- Buffer queue is bounded and drops capture attempts if no writable input slot is available.
- Private object offsets, dispatch order and function signatures require a matching binary. Small instruction guards are not general ABI compatibility verification.
- Live socket mode supports reconnect, stream size/FPS/bitrate settings, keyframe requests and bounded output; native display resize/rotation, repeated native capture sessions and production teardown remain unsupported.
- This proves the Linux NVIDIA path. It does not measure Apple Silicon/IOSurface/VideoToolbox.

For product integration, put the hook inside a matching renderer build, expose a supported capture session API, implement teardown and display changes, preserve presentation timestamps, and deliver compressed packets to the existing transport.

## Live Device Hub experiment

Use the same driver, encoder build and disposable emulator setup above. For a
new live-demo AVD, use `POC_DEVICE_PROFILE=pixel_2 bash setup-emulator.sh`; its
720×1280 aspect ratio avoids mismatched Pixel 9 frame artwork in the Hub. Build the
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
only. Unset both experiment variables to return to normal capture. The existing
Max size, Video FPS and Video bitrate controls now configure the experimental
encoder independently of the emulator display. See the settings experiment below.

The socket carries a 32-byte big-endian header followed by one complete FFmpeg
AVPacket: magic `GPC1`, payload length u32, presentation timestamp in microseconds
u64, flags u32 (0=delta, 1=keyframe, 2=native display handshake, 3=settings
acknowledgement), width u32, height u32 and FPS u32. Both handshake records have
empty payloads. A client sends `K` to request an IDR, or `S` followed by three
big-endian u32 values: longest-edge cap (0=native), FPS and bitrate. The native
hello reports source dimensions and the injection default FPS, not measured VSync.
The settings acknowledgement reports encoded dimensions/FPS. No video is sent
until settings are applied. Reconnect for each settings change. The adapter extracts SPS/PPS and
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

See [live validation and screenshots](results/live/README.md) for the ngrok browser,
controls, idle refresh, multiple-tab and Hub restart checks.

For the live 4K/WebRTC configuration, stop and restart the dedicated emulator with
2160×3840, density 720, `hw.lcd.vsync=120` and `POC_VSYNC=120 bash launch.sh`.
Inject with `--fps 120` and a fresh socket path, then launch the Hub using
`POC_VSYNC=120 POC_TRANSPORT=webrtc SERVE_EMU_EXPERIMENTAL_GPU_SOCKET=<path> bash run-hub.sh`.
The interactive fixture requests 120 Hz and scales its layout with display density.
Check measured server/client rates in Stream options; the configured rate does
not guarantee that the full browser loop delivers 120 FPS.

## Pixel 9 profile at 120 Hz

This is the current live experiment configuration. With the SDK and native module
already prepared, stop the old experiment before creating a **fresh** AVD. Do not
use `setup-emulator.sh` for this case: that older benchmark helper overrides the
profile's resolution and density.

```sh
bash stop-emulator.sh # default: the earlier gpu_poc AVD
export POC_AVD=pixel9_gpu_live
export POC_VSYNC=120
export POC_TRANSPORT=webrtc
bash setup-pixel9.sh
bash launch.sh
# After Android finishes booting:
adb -s emulator-5554 install -r animation/build/animation.apk
sudo .venv/bin/python inject.py "$(cat emulator.pid)" \
  --seconds 1800 --frames 100000000 --fps 120 \
  --output unix:/tmp/gpu-pixel9-120.sock > pixel9-capture.log 2>&1 &
# Wait for the injector's ready message before launching the fixture.
adb -s emulator-5554 shell -n am start -n dev.expo.gpupoc/.LiveActivity
SERVE_EMU_EXPERIMENTAL_GPU_SOCKET=/tmp/gpu-pixel9-120.sock bash run-hub.sh
# When done, keep POC_AVD set and run: bash stop-emulator.sh
```

`setup-pixel9.sh` preserves the generated Pixel 9 profile and changes only
`hw.lcd.vsync` to 120. On the tested SDK the profile is **1080×2424 at 420 DPI**.
The launch options remain headless host GPU, Vulkan disabled, KVM, four CPU cores,
4096 MiB RAM and port 5554. These are the existing runtime options, not extra AVD
configuration edits. Hub uses native size (`--max-dimension 0`),
`--video-fps 120`, WebRTC and the same fixed 12 Mbps NVENC encoder.

The fresh worker AVD was verified with `wm size` and `wm density`: physical
1080×2424 and density 420, with no overrides. Android reported an active 120 Hz
mode. Comparing its generated config before and after launch found only
`hw.lcd.vsync: 60 → 120`. Chrome received 1080×2424 WebRTC video, and the old
emulator process had exited. The sampled source rate was 112 FPS; 120 remains
the requested rate. Choose a fresh socket path for every injection and keep the
capture duration inside the remaining worker allocation.


## Independent stream resolution and FPS (experimental)

The Pixel 9 keeps its native **1080×2424 / 420 DPI / 120 Hz** profile. The Hub's
**Max size** setting caps the stream's longest edge, preserves aspect ratio to
within even-pixel rounding, and never upscales. For example, 1280 produces
570×1280; Full restores 1080×2424. **Video FPS** sets a capture/encode maximum,
independent of Android VSync. Android's selector includes 120 FPS so it remains
available after choosing a lower rate.

A monotonic capture pacer skips samples before renderer locking, CUDA mapping or
copying. Selected frames retain real elapsed-time timestamps; no slow motion or
catch-up queue is introduced. Keyframe recovery can send an extra repeated frame,
and idle streams retain the existing low-rate refresh behavior. The FPS cap does
not promise that the app, machine or browser will sustain that rate.

Captured frames stay at native size in a bounded CUDA pool. The encoder worker
retains the latest native frame and runs a small bilinear RGBA CUDA kernel when
scaling is requested. Full size bypasses scaling. This deliberately retains a
native-sized GPU copy so an idle display can switch back to full resolution;
resolution reduction alone does not reduce that copy or the emulator's rendering
work. Lower FPS reduces capture work. Raw video never crosses to the CPU.

The existing settings endpoint closes/reopens the private socket session. The
worker discards queued old samples and recreates only NVENC/output buffers, then
acknowledges the format and sends SPS/PPS plus an IDR. The hook, native frame pool,
emulator and app stay alive. Control gestures use native dimensions, independent
of encoded dimensions. `/health.experimentalGpuCapture` reports both sizes and
the requested stream FPS. One encoder is shared by every viewer of the device.

For an existing build environment, install the build-only kernel compiler once:

```sh
.venv/bin/pip install nvidia-cuda-nvrtc-cu12==12.9.86
bash build.sh
```

`compile-scale.py` embeds PTX in the library; NVRTC is not loaded into the
emulator. Deploy the native library and TypeScript adapter together and restart
the emulator once for the new library. The older adapter does not understand the
settings handshake. To include the persistent 120 FPS dropdown option, also
build the Hub client (hub-client, hub-components, then expo-device-hub build:web)
instead of retaining the published UI from install-hub.sh.

Initial stream settings can be selected with `POC_STREAM_FPS` and
`POC_MAX_DIMENSION` when running `run-hub.sh`. `POC_VSYNC` still controls emulator
launch separately. Keep bitrate fixed when comparing FPS/resolution unless the
experiment specifically measures bitrate changes.

Validation on the existing L4 worker (2026-09-11): native library/PTX built;
UI selected 1280 and 30 FPS; browser decoded 570×1280 over WebRTC; a tap on the
scaled image paused the animation; settings restored native 1080×2424 while the
image was static, then downscaled again without an emulator restart. Android
still reported 1080×2424, 420 DPI and 120.00001 Hz. Capture audit reported zero
errors and zero capture GL readbacks (some busy capture drops occurred).
A short 30 FPS sample reported approximately 31 FPS (155 frames across the
five-second wait plus HTTP overhead); a 60 FPS sample delivered 312 frames over
5.357 seconds (~58 FPS). Restoring native size / 120 FPS decoded at 1080×2424.
These are short live samples, not a sustained benchmark.
WebRTC ICE reconnection was sometimes slow; an already connected viewer remained
connected across changes. This experiment does not address ICE/network behavior.

Checks: native stream-size/pacer assertions, private protocol tests, serve-emu
aggregate check (996 tests, coverage, typechecks, build and package smoke), 48 Hub
inspector tests, and Hub client build. Run the native assertions with:

```sh
clang++ -std=c++17 stream-format.test.cpp -o /tmp/gpu-stream-format-test
/tmp/gpu-stream-format-test
```
