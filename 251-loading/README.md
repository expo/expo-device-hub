# PR #251: MP4 index position and browser loading

This folder preserves the October 4, 2026 measurement and the range-server/browser
harness. The product PR only enables `AVAssetWriter.shouldOptimizeForNetworkUse`.

Download the pinned evidence tree using the [bundle instructions](../README.md),
keeping it separate from your production source checkout.

## Recorded evidence

`original-loading-comparison.json` contains every one of the 12 valid trials and
the six alternating pairs. `original-browser-results.jsonl` and
`original-http-requests.jsonl` preserve event and HTTP records. Run:

```sh
python3 summarize.py original-browser-results.jsonl > original-summary.json
```

Median source assignment to `loadeddata`: tail index 497.25 ms, front index
194.90 ms (60.8% lower). All six pairs improved; every trial used 3 versus 1 media
range requests. `original-packet-proof.json` records equal hashes, timestamps,
durations and flags for all 2,093 compressed packets, plus codec extradata.

The original input was a fresh October 4 recording from the fast-start-only
`2749548a49eae6a88677d62e1e87365de5c5f1b4` tree, before the later rollback/merge.
It was already front indexed; FFmpeg produced the tail-index control. This is a
file-layout comparison, **not two recordings made with the final PR flag on/off**.
The same flag is the sole production change above #254 at final head
`bbea0ee78ddf75fd87dfb8bfff985b98136578f7`.

The original MP4s are not included. Generate a new input as below; timings and
request counts can differ with its content, size and your browser. The saved
JSON makes the reported arithmetic independently checkable.

## Reproduce with a new recording

Requirements: macOS Apple Silicon, Xcode with an available iOS Simulator runtime,
Node 24, Bun 1.3.14, Python 3.10+, FFmpeg/ffprobe. Original environment was Xcode
26.4 (17E192), iOS 26.4, iPhone 17 Pro (1206 x 2622), FFmpeg 8.1.2 and Chromium
152. Keep the browser visible for every trial.

In a separate checkout of `expo/expo-device-hub`, build the pinned PR head:

```sh
git fetch origin bbea0ee78ddf75fd87dfb8bfff985b98136578f7
git switch --detach bbea0ee78ddf75fd87dfb8bfff985b98136578f7
bun install --frozen-lockfile
cd packages/serve-sim
bun run build
```

Boot a Simulator you own. `record-video` needs a running serve-sim session. In
one terminal, from that checkout's `packages/serve-sim` directory, start a
loopback session with an isolated state directory (use a free port):

```sh
export SERVE_SIM_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loading-state.XXXXXX")"
printf 'State directory: %s\n' "$SERVE_SIM_STATE_DIR"
node packages/serve-sim/dist/serve-sim.js --port 8774 --host 127.0.0.1 --require-token YOUR_OWNED_SIMULATOR_UDID
```

Check `curl -fsS http://127.0.0.1:8774/readyz` reports `"status":"ready"`.
In a second terminal, from the same directory,
set `SERVE_SIM_STATE_DIR` to the exact directory printed above, then record:

```sh
export SERVE_SIM_STATE_DIR=STATE_DIRECTORY_PRINTED_BY_FIRST_TERMINAL
node packages/serve-sim/dist/serve-sim.js record-video --udid YOUR_OWNED_SIMULATOR_UDID --output /tmp/loading-recording
```

Choose a new output directory if `/tmp/loading-recording` already exists.
Record at least 30 seconds with visible app motion, then press Ctrl-C once in
the recording terminal and wait for finalization. Locate its `recording.mp4`;
then stop the session in the first terminal with Ctrl-C. Do not prepare media
or start the loading harness until capture has finished. Copy this evidence
folder to a writable temporary location and run from it:

```sh
python3 prepare.py /tmp/loading-recording/recording.mp4 --source-head bbea0ee78ddf75fd87dfb8bfff985b98136578f7
python3 server.py --port 8773
```

Preparation refuses to benchmark if the source is not front indexed or if remux
changes any packet/timestamp/codec identity. Open `http://127.0.0.1:8773/` in a
visible Chromium browser and click **Run six pairs** once. Odd pairs run tail
then front; even pairs reverse the order. Each trial has a unique no-store URL.
After **Complete: 12 trials recorded**, in a second terminal:

```sh
python3 summarize.py browser-results.jsonl > reproduction-summary.json
```

Retain all invalid reasons. Do not silently replace invalid trials or add pairs
until a preferred result appears. Save the summary, packet proof, HTTP log and
browser log together. Stop the loopback server with Ctrl-C.

## Definitions and limits

The server delays every media response by 150 ms and applies one shared 80 Mbps
budget to simultaneous media requests within a trial. This is a simulated local
network, not hosted EAS performance. `loadeddata` means a frame at the current
playback position is available. The video-frame callback measures composition
callback delivery, not pure decode time.

No-store URLs avoid reusing media resources; decoder/process initialization and
kernel caches may remain warm. FFmpeg remux also changes container metadata and
chunking, which can affect the magnitude. This evidence supports loading under
the stated conditions; it does not measure recorded-frame smoothness, sustained
playback drops or live-stream impact. Recording bitrate was not lowered.
