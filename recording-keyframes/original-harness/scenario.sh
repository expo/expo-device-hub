#!/usr/bin/env bash
# One 60 s recording of a realistic scenario on a dedicated simulator.
#   scenario.sh <out dir> <still|navigate|scroll> record-sim
#   scenario.sh <out dir> <still|navigate|scroll> serve-sim <keyframe interval in frames>
set -euo pipefail
OUT="$1"; SCENARIO="$2"; RECORDER="$3"; KF="${4:-60}"
UDID=<author-test-simulator>
SERVE_SIM="node <serve-sim-checkout>/packages/serve-sim/packages/serve-sim/dist/serve-sim.js"
RECORD_SIM=<author-cache>/record-sim-build/arm64-apple-macosx/release/record-sim
APPS=(com.apple.Preferences com.apple.mobilecal com.apple.MobileAddressBook com.apple.DocumentsApp com.apple.reminders com.apple.mobileslideshow)
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
mkdir -p "$OUT"
for app in "${APPS[@]}"; do xcrun simctl terminate "$UDID" "$app" 2>/dev/null || true; done
xcrun simctl launch "$UDID" com.apple.Preferences > /dev/null

# serve-sim runs in every config, with an EAS session's flags, as in a session.
SERVE_SIM_RECORDING_KEYFRAME_INTERVAL="$KF" $SERVE_SIM --port "$PORT" --host 127.0.0.1 --require-token \
  --transport webrtc --webrtc-codec h264 --max-dimension 1600 --video-bitrate 10000000 --video-fps 60 \
  "$UDID" > "$OUT/serve-sim.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 120); do
  curl -sf "http://127.0.0.1:$PORT/readyz" | grep -q '"ready"' && break
  sleep 1
done
sleep 3

if [ "$RECORDER" = record-sim ]; then
  "$RECORD_SIM" --udid "$UDID" --output "$OUT/recording" --segment-duration 0 > "$OUT/recorder.log" 2>&1 &
else
  $SERVE_SIM record-video --udid "$UDID" --output "$OUT/recording" > "$OUT/recorder.log" 2>&1 &
fi
REC=$!
sleep 2

START=$(date +%s)
case "$SCENARIO" in
  still) sleep 60 ;;
  navigate)
    for i in $(seq 0 9); do
      xcrun simctl launch "$UDID" "${APPS[$((i % ${#APPS[@]}))]}" > /dev/null
      sleep $((START + 6 * (i + 1) - $(date +%s) > 0 ? START + 6 * (i + 1) - $(date +%s) : 0))
    done ;;
  scroll) node "$(dirname "$0")/drag.mjs" "$UDID" ;;
esac
kill -INT "$REC"
wait "$REC" || echo "recorder exit $?"
echo "scenario $SCENARIO took $(( $(date +%s) - START )) s"
