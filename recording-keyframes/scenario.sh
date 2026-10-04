#!/usr/bin/env bash
# Portable version of the original scenario harness. Drive only a simulator you own.
# Usage: scenario.sh <output> <still|navigate|scroll> <serve-sim|record-sim> [frame interval]
set -euo pipefail
umask 077
OUT=$1
SCENARIO=$2
RECORDER=$3
KF=${4:-60}
: "${REPO:?Set REPO to the pinned expo-device-hub checkout}"
: "${SERVE_SIM_TEST_UDID:?Set SERVE_SIM_TEST_UDID to your booted test simulator}"
UDID=$SERVE_SIM_TEST_UDID
CLI=$REPO/packages/serve-sim/packages/serve-sim/dist/serve-sim.js
[[ $SCENARIO = still || $SCENARIO = navigate || $SCENARIO = scroll ]] || exit 2
[[ $KF = 120 || $KF = 60 || $KF = 30 || $KF = 15 ]] || exit 2
[[ ! -e $OUT ]] || { echo "Use a new output directory: $OUT" >&2; exit 2; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
export SERVE_SIM_STATE_DIR=$OUT/private-state
APPS=(com.apple.Preferences com.apple.mobilecal com.apple.MobileAddressBook com.apple.DocumentsApp com.apple.reminders com.apple.mobileslideshow)
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
SERVER=
REC=
cleanup() {
  if [[ -n $REC ]]; then kill -INT "$REC" 2>/dev/null || true; wait "$REC" 2>/dev/null || true; fi
  if [[ -n $SERVER ]]; then kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; fi
}
trap cleanup EXIT
for app in "${APPS[@]}"; do xcrun simctl terminate "$UDID" "$app" 2>/dev/null || true; done
xcrun simctl launch "$UDID" com.apple.Preferences > /dev/null
# These are the original session flags. Recording itself remains native 30 Mbps/60 Hz.
SERVE_SIM_RECORDING_KEYFRAME_INTERVAL=$KF node "$CLI" --port "$PORT" --host 127.0.0.1 --require-token \
  --transport webrtc --webrtc-codec h264 --max-dimension 1600 --video-bitrate 10000000 --video-fps 60 \
  "$UDID" > "$OUT/serve-sim.log" 2>&1 &
SERVER=$!
READY=0
for _ in $(seq 120); do
  if curl -sf "http://127.0.0.1:$PORT/readyz" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status") == "ready" else 1)' 2>/dev/null; then READY=1; break; fi
  kill -0 "$SERVER" || exit 1
  sleep 1
done
[[ $READY = 1 ]] || { echo "Server readiness timed out" >&2; exit 1; }
sleep 3
case "$RECORDER" in
  record-sim)
    : "${RECORD_SIM_BIN:?Set RECORD_SIM_BIN for the optional record-sim context rows}"
    "$RECORD_SIM_BIN" --udid "$UDID" --output "$OUT/recording" --segment-duration 0 > "$OUT/recorder.log" 2>&1 & ;;
  serve-sim)
    node "$CLI" record-video --udid "$UDID" --output "$OUT/recording" > "$OUT/recorder.log" 2>&1 & ;;
  *) exit 2 ;;
esac
REC=$!
sleep 2
START=$(date +%s)
case "$SCENARIO" in
  still) sleep 60 ;;
  navigate)
    for i in $(seq 0 9); do
      xcrun simctl launch "$UDID" "${APPS[$((i % ${#APPS[@]}))]}" > /dev/null
      DELAY=$((START + 6 * (i + 1) - $(date +%s)))
      (( DELAY <= 0 )) || sleep "$DELAY"
    done ;;
  scroll) node "$(dirname "$0")/drag.mjs" "$UDID" ;;
esac
kill -INT "$REC"
wait "$REC"
REC=
ffprobe -v error -select_streams v:0 -show_entries \
  packet=pts_time,dts_time,duration_time,flags,size:stream=width,height,codec_name,profile,has_b_frames,avg_frame_rate:format=duration,size \
  -of json "$OUT/recording/recording.mp4" > "$OUT/ffprobe.json"
echo "Recorded $SCENARIO / $RECORDER / $KF frames"
