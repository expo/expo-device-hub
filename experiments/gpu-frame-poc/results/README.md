# Measured results — 2026-09-11

Dedicated EAS staging run: [01a09019-72e1-7554-ae09-2d13cd512284](https://staging.expo.dev/accounts/expo/projects/krystof-test/workflows/01a09019-72e1-7554-ae09-2d13cd512284).
Worker: `turtle-worker-2efbc490ffb4`, NVIDIA L4, 8 vCPU, 31 GiB RAM.
The dedicated workflow was canceled after the measurements and artifact export, within the two-hour limit. The separate Device Hub workflow was not modified.

Renderer SHA-256:
`86e21e94fb0c1a6313288549953240289d071e0f9a75a2b5e80495bc97fae30a`

The final implementation explicitly waits for CUDA stream completion before handing its buffer to the encoder worker. Early runs omitted this host wait; their approximately 0.05 ms CUDA API durations measured submission rather than confirmed copy completion. Use the final `*-sync` measurements for copy cost.

The guest workload draws colored regions, a moving rectangle, text and a 16-bit frame barcode using a hardware-accelerated Android View. This is a simple sustained animation, not a representative game or a quality/bitrate stress test. Encoding uses H.264 NVENC p1/ull, no B frames and a 12 Mbps target.

## Final result: 2160 × 3840 at 120 Hz

| Measurement | Result |
| --- | ---: |
| Source display posts, capture off (20 seconds) | 118.34 fps |
| Recorded frames | 3,600 |
| Measured capture rate, excluding warmup | **119.96 fps** |
| Capture queue drops / errors | **0 / 0** |
| Decoded frames / unique barcodes | **3,600 / 3,600** |
| Duplicate, skipped or backward barcodes | **0** |
| Capture wall time, mean / p95 | **0.822 / 0.951 ms** |
| CUDA map/copy/unmap/completion wait, mean / p95 | **0.284 / 0.308 ms** |
| First-frame setup and capture | 311.975 ms |
| Capture-scope `glReadPixels` / `glGetTexImage` | **0 / 0** |

At 120 fps the frame interval is 8.33 ms. The measured capture section occupies about 9.9% of that interval on average. Encoding runs separately and kept up with this workload. The baseline and capture intervals are consecutive samples, not randomized trials; their small FPS difference does not show that capture improves rendering.

Native readback counters cover renderer-dispatch `glReadPixels`/`glGetTexImage` calls within capture. They do not establish that the entire emulator has no readbacks. Raw frame copies in this module use a CUDA array source and device-memory destination; compressed output is written by the CPU.

Timings exclude the first ten frames. Encoder setup occurs on the first captured frame and causes a one-time visible hitch; production integration should initialize the encoder before recording. CPU wall times are not isolated GPU event timings or end-to-end latency.

## Saved evidence

- [Summary](4k-120-sync-summary.json), [frame timings](4k-120-sync.csv), [capture counters](4k-120-sync-native.txt).
- [Source baseline](4k-120-sync-baseline.json), [decoded frame count](4k-120-sync-probe.json), [barcode validation](4k-120-sync-validation.json).
- [Two-second 4K 120 fps sample](4k-120-preview.mp4): copied from the encoded stream without re-encoding; playback rate explicitly set during remuxing.
- [First frame preview](4k-first-frame.png): decoded and resized to 540 × 960 for inspection, outside the recording pipeline.

This proves sustained local capture and encoding for this workload. It does not measure network transport, browser decoding/display, encode latency, real applications, macOS or Apple Silicon.
