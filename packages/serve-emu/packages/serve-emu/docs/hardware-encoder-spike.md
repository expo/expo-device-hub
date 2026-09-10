# Hardware H.264 encoder spike

Validated on 2026-09-10 on macOS 26.6.2, Apple M4 Pro, Homebrew ffmpeg 9.0.1.
The plan's older M2 / ffmpeg 8.1.2 environment description does not describe this host.

## VideoToolbox results

The final encoder command uses the existing RGB/PNG input and crop/rotation filters,
then the following output arguments (shown for a 30 fps, 1 Mbps stream):

```sh
-pix_fmt nv12 -c:v h264_videotoolbox -allow_sw 0 -realtime 1 \
-flags +low_delay -profile:v baseline \
-b:v 1000000 -maxrate 1000000 -bufsize 1000000 -g 30 -bf 0 \
-bsf:v h264_metadata=aud=insert -f h264 -flush_packets 1 pipe:1
```

`ffmpeg -hide_banner -h encoder=h264_videotoolbox` describes `allow_sw` as allowing
software encoding; the smoke and session commands explicitly set it to zero.
The smoke succeeds with that restriction, so VideoToolbox software fallback cannot
satisfy hardware selection.

The proposed `-realtime 1 -bf 0` arguments alone retain one encoded frame: supplying
an original screenshot and exactly one duplicate produces one AUD before EOF.
The parser cannot publish the original frame without the duplicate's AUD.
Adding `-flags +low_delay` produces both access units before EOF, preserving the
existing idle-flush behavior. FFmpeg's [VideoToolbox implementation](https://www.ffmpeg.org/doxygen/7.1/videotoolboxenc_8c_source.html)
maps this flag to `EnableLowLatencyRateControl`.

The original spike used six 128×128 RGB24 frames, 30 fps, 1 Mbps and a two-frame
keyframe interval. For that experiment,
`ffprobe -show_frames -show_streams` reported:

| Encoder | Decoded frame types | Profile | B frames | AUD count | SPS/PPS count |
| --- | --- | --- | --- | --- | --- |
| libx264 | I, P, I, P, I, P | Constrained Baseline | 0 | 6 | 3 each |
| h264_videotoolbox | I, P, I, P, I, P | Baseline | 0 | 6 | 3 each |

VideoToolbox emitted 595 bytes. Each IDR was preceded by SPS/PPS, allowing the
existing parser/config cache to support a new viewer. Three process-start,
six-frame encode, and process-exit runs took 320, 306 and 310 ms for VideoToolbox;
software took 31, 31 and 30 ms. These tiny-frame startup measurements are not a
sustained CPU or browser-latency benchmark.

The production smoke encode and the automated real-hardware test use 256×256
RGB24 frames. This exceeds the H.264 minimum width of 145 pixels on Turing and
newer NVENC hardware, avoiding a false unavailable result from a too-small probe.
NVIDIA confirms that [Turing and newer GPUs require larger minimum dimensions](https://forums.developer.nvidia.com/t/minimum-width-in-turing-gpus/155566).
A resolver regression test checks the NVENC command's actual input dimensions and
that stdin contains four complete RGB24 frames.

The updated 256×256 real-hardware test keeps stdin open, submits only an original
frame and one duplicate, and requires configuration plus the original keyframe.
The VideoToolbox probe and this streaming test passed after the dimension change.
The 128×128 measurements above remain the original spike results. Run:

```sh
bun test packages/serve-emu/packages/serve-emu/tests/h264-encoder.test.ts
```

The hardware test skips when the host probe cannot provide hardware encoding.
A companion test requires an actionable error on such hosts. Software command
regression tests compare the entire argument array, including the PNG variant.

## Other hosts

NVENC and VAAPI arguments have deterministic unit coverage for device selection,
pixel conversion, rate control, zero B frames/lookahead, AUD insertion, and GOP
settings. Neither backend exists in this Mac's ffmpeg build, and no Linux GPU was
available for a live encode. They remain unverified on real Linux hardware.

On Linux, selection tries NVENC then VAAPI. A backend must pass an actual bounded
encode containing SPS, PPS, an IDR, and multiple AUDs before it can be selected.
A pinned backend is the sole candidate. Failed attempts retain a bounded stderr
tail and can be retried; they never select libx264. The VAAPI probe also checks
read/write access to the chosen render device.
