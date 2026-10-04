# PR243: source data and reproduction

These are the retained **2026-10-02** measurements underlying the PR's chart: 24 serve-sim recordings and six contextual record-sim recordings. They are not fresh runs. [results.csv](results.csv) gives every recording's size, duration, keyframe spacing and presentation/decode timestamp measurements. [raw/](raw/) contains the packet metadata for each run; [recordings.json](recordings.json) gives hashes of the source MP4s. No video content, device state or authentication logs are published. [provenance.json](provenance.json) records the measured source and settings.

## Obtain the evidence

Clone the evidence branch separately from the source checkout, then detach at the evidence commit linked in the PR to freeze the inputs:

```sh
git clone --branch gwdp/recording-reviewer-evidence --single-branch https://github.com/expo/expo-device-hub.git recording-evidence
cd recording-evidence
git checkout --detach EVIDENCE_COMMIT_FROM_PR
cd recording-keyframes
```

## Recalculate the published numbers without a Simulator

Requirements: Python 3. Run in this directory:

```sh
python3 analyze.py --verify raw original-size-results.json
python3 analyze.py --csv raw > recalculated.csv
python3 analyze.py raw > recalculated.json
```

Expected verification: all **30 original runs match** for duration, packet count, MB/min, keyframe count/gap and keyframe byte share. Each PR cell is the arithmetic mean of its two runs' `mbPerMin`, where `MB/min = sizeBytes / 1,000,000 / formatDurationSeconds * 60`. The longest gap is the maximum over both runs. Timestamps are seconds, sizes decimal MB; FPS in the presentation table is `(packetCount - 1) / (lastPTS - firstPTS)`.

The six 120-frame serve-sim files have a maximum keyframe gap of **2.00 seconds**; the six 60-frame files have **1.00 second**. Mean MB/min changes are still **4.62 → 8.22**, switching apps **34.01 → 36.58**, and scrolling **39.53 → 44.35**. These measurements demonstrate the keyframe/file-size tradeoff. They do not measure browser seek latency or smoothness.

`ptsBackstepsInPacketOrder` counts adjacent PTS decreases in encoded packet order. Encoders using B-frames can produce those normally because decode and presentation order differ. It is **not a count of visible playback order errors**. `presentationGapMaxMs` is computed after sorting by presentation timestamp, not by packet order.

## Re-run the keyframe contract test

Use an Apple Silicon Mac with Xcode and hardware VideoToolbox encoding. This test creates its own pixel buffers; it does not need a booted Simulator:

```sh
git clone https://github.com/expo/expo-device-hub.git recording-review
cd recording-review
git fetch origin 9f49f1f4ab30815515bfe967424f1387db6d10af
git checkout --detach 9f49f1f4ab30815515bfe967424f1387db6d10af
bun install --frozen-lockfile
cd packages/serve-sim/packages/serve-sim
swift test --filter NativeVideoRecorderKeyframeTests
```

The two tests check continuous keyframe spacing (with a small timer tolerance) and that the first picture after a source pause longer than one second is a keyframe. A source pause still leaves a gap in the file. The tests do not promise one-second seek precision or measure a browser.

## Re-run the size scenarios

Requirements: that checkout, Bun/Node, `ffprobe`, Xcode 26.4 with an iOS 26.4 iPhone 17 Simulator **you own**, and the evidence directory copied outside the source checkout. Close permission/onboarding prompts in the six system apps before measuring; the original run granted Calendar location permission. The Settings list must visibly scroll. The device run takes about 26 minutes for the 24 serve-sim samples.

Use a fresh throwaway source checkout. Set `EVIDENCE` to this directory and `REPO` to that checkout. The only source change below is the historical experiment patch, which makes both keyframe limits configurable for measurement. It is not part of the production PR. It applies unchanged at the published PR head:

```sh
export EVIDENCE=/path/to/recording-keyframes
export REPO=/path/to/recording-review
export SERVE_SIM_TEST_UDID=YOUR_OWNED_SIMULATOR_UDID
cd "$REPO"
git apply --check "$EVIDENCE/original-interval-experiment.patch"
git apply "$EVIDENCE/original-interval-experiment.patch"
bun install --frozen-lockfile
bun run packages/serve-sim/packages/serve-sim/build.ts
bash "$EVIDENCE/matrix.sh" "$PWD/keyframe-results"
```

The portable harness uses the original session flags, native recording bitrate (30 Mbps), two passes with reversed configuration order, and scenarios: Settings idle for 60 seconds; launch a system app every six seconds; or 20 alternating Settings drags three seconds apart. It starts a fresh server and uses a private state directory for every recording. No browser viewer is opened. The production flag for preview bitrate does not set the recording bitrate.

The new files and packet exports are under `keyframe-results/`. Analyze them independently with:

```sh
python3 "$EVIDENCE/analyze.py" --csv "$REPO/keyframe-results/raw"
```

Optional contextual record-sim rows: build the `record-sim` Swift package from the EAS CLI source you want to compare, record its commit and toolchain, and set `RECORD_SIM_BIN` to the resulting binary before running the matrix. This adds six recordings. The original comparator's binary hash is retained, but its exact source commit was not saved; do not treat a new comparator build as the same historical binary.

To export the same fields from any independently produced MP4:

```sh
ffprobe -v error -select_streams v:0 -show_entries \
  packet=pts_time,dts_time,duration_time,flags,size:stream=width,height,codec_name,profile,has_b_frames,avg_frame_rate:format=duration,size \
  -of json recording.mp4 > ffprobe.json
```

The original local harness is retained under [original-harness/](original-harness/) with private paths replaced by placeholders. The portable harness additionally checks server readiness, waits for HID admission and cleans up its processes. Its shell/Node syntax and metadata analysis were checked; the portable device harness has not been re-run on a Simulator. Individual file sizes/timings vary with toolchain, device state and source activity; the historical numbers are descriptive rather than acceptance thresholds.
