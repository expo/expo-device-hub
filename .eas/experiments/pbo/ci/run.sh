#!/bin/bash
# Compare the normal reader twice, then the PBO reader on the same boot/VM.
# Linux software renderers, direct socket consumers and the eight-color page.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE=$1
CONFIG=$2
source "$ROOT/ci/lib.sh"
VARIANTS=${VARIANTS:-"v1:960:- v2:1280:- v3:960:0 v4:1280:0 v5:960:960 v6:1280:1280"}
PROBE=${PROBE:-1}
STREAM_BITRATE=12000000 # serve-emu's capture session default
RECORDING_BITRATE=8000000 # serve-emu's recording default
case "$CONFIG" in
  base) AVD=${PROFILE}_base; GPU=lavapipe ;;
  basess) AVD=${PROFILE}_basess; GPU=swiftshader_indirect ;;
  *) echo "unknown config $CONFIG"; exit 1 ;;
esac
D="$OUT/$CONFIG/$PROFILE"
mkdir -p "$D"
trap 'tar czf "$ROOT/results-$CONFIG.tar.gz" -C "$ROOT" "out/$CONFIG" out/avd logs' EXIT
consumer() { node "$ROOT/ci/consumer.mjs" --capture "$CAP" --socket "$SOCK" "$@"; }
page_frames() { node "$ROOT/ci/page-frames.mjs" 9223 "$WS" > "$1" 2> /dev/null; }

echo "::: Machine"
echo "vcpus $(nproc); $(grep -m1 'model name' /proc/cpuinfo); $(grep MemTotal /proc/meminfo)"
ls -la "$CAP/dist/linux-x64/libexpo_emulator_capture.so" || exit 1
install_ws || exit 1
start_http

window() { # window <dir> <stream> <recording> <probe 0|1>
  local dir=$1 stream=$2 recording=$3 probe=$4 rec_pid="" stream_pid mark
  mkdir -p "$dir"
  if [ "$probe" = 2 ]; then echo 1 > "$SOCK.pbo"; else rm -f "$SOCK.pbo"; fi
  rm -f "$SOCK.read"
  if [ "$probe" = 1 ]; then echo 1 > "$SOCK.probe"; else rm -f "$SOCK.probe"; fi
  mark=$(wc -l < "$AGENT_LOG")
  if [ "$recording" != - ]; then
    consumer --role recording --max-size "$recording" --fps 60 --bit-rate $RECORDING_BITRATE --seconds 34 \
      --out "$dir/recording" > "$dir/recording.json" 2> "$dir/recording.err" &
    rec_pid=$!
    sleep 0.3
  fi
  consumer --role stream --max-size "$stream" --fps 60 --bit-rate $STREAM_BITRATE --seconds 33 \
    --out "$dir/stream" > "$dir/stream.json" 2> "$dir/stream.err" &
  stream_pid=$!
  sleep 2
  python3 -I "$ROOT/ci/cpu-snap.py" "$dir/cpu-a.txt" "qemu=$QEMU" "stream=$stream_pid" ${rec_pid:+"recording=$rec_pid"}
  page_frames "$dir/page-a.json"
  sleep 30
  python3 -I "$ROOT/ci/cpu-snap.py" "$dir/cpu-b.txt" "qemu=$QEMU" "stream=$stream_pid" ${rec_pid:+"recording=$rec_pid"}
  page_frames "$dir/page-b.json"
  mem_snap "$dir/mem.txt"
  wait "$stream_pid" ${rec_pid:+"$rec_pid"}
  sleep 0.5
  tail -n +"$((mark + 1))" "$AGENT_LOG" > "$dir/agent.txt"
  echo "  $(basename "$dir"): page fps $(python3 -I "$ROOT/ci/page-fps.py" "$dir/page-a.json" "$dir/page-b.json"); stream frames $(grep -oE '"frames":[0-9]+' "$dir/stream.json" | head -1)$( [ -n "$rec_pid" ] && echo "; recording frames $(grep -oE '"frames":[0-9]+' "$dir/recording.json" | head -1)"); QEMU RSS $(grep VmRSS "$dir/mem.txt" | awk '{print $3, $4}')"
  grep -E "stats \(|fail|error" "$dir/agent.txt" | tail -3 | cut -c1-260 | sed 's/^/    /'
  sleep 3
}

echo "::: $PROFILE $CONFIG: $AVD, -gpu $GPU "
AGENT_LOG="$LOGS/agent-$CONFIG.log"
T0=$(now_ms)
# shellcheck disable=SC2086
launch_emulator "$AVD" "$CONFIG" -gpu "$GPU"
wait_boot "$T0" "$D/boot.json" && wait_socket || { echo "$AVD did not start"; tail -40 "$LOGS/emulator-$CONFIG.log"; stop_emulator; exit 1; }
grep -m1 -iE "boot completed in" "$LOGS/emulator-$CONFIG.log" || true
QEMU=$(qemu_pid)
qemu_facts | tee "$D/qemu.txt"
sleep 20
mem_snap "$D/mem-boot.txt" full
echo "memory 20 s after the boot: $(grep -E 'VmRSS|^qemu_rollup Pss:' "$D/mem-boot.txt" | awk '{print $2, $3}' | tr '\n' ' '); guest $(grep -E '^guest MemAvailable' "$D/mem-boot.txt" | awk '{print $2, $3}')"
prepare_chrome
sleep 45
$ADB shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null 2>&1
$ADB shell input keyevent KEYCODE_HOME > /dev/null 2>&1
sleep 5
$ADB exec-out screencap -p > "$D/home.png"
mem_snap "$D/mem-idle.txt" full
echo "memory at the home screen: $(grep -E 'VmRSS|^qemu_rollup Pss:' "$D/mem-idle.txt" | awk '{print $2, $3}' | tr '\n' ' '); guest $(grep -E '^guest MemAvailable' "$D/mem-idle.txt" | awk '{print $2, $3}'); $(grep -E '^dumpsys' "$D/mem-idle.txt" | tr '\n' ' ' | cut -c1-300)"
device_facts "$AVD" "$CONFIG" | tee "$D/device.txt"
open_page "$PAGE"
$ADB forward tcp:9223 localabstract:chrome_devtools_remote > /dev/null
$ADB exec-out screencap -p > "$D/page.png"
page_frames "$D/page-check.json"
node "$ROOT/ci/page-info.mjs" 9223 "$WS" > "$D/page-info.json" 2> /dev/null
echo "page counter: $(cat "$D/page-check.json"); page info: $(cat "$D/page-info.json")"

echo "::: $PROFILE $CONFIG baseline: no consumer, 30 s"
rm -f "$SOCK.read" "$SOCK.probe"
consumer --hello-only > "$D/baseline-hello-a.json"
python3 -I "$ROOT/ci/cpu-snap.py" "$D/baseline-cpu-a.txt" "qemu=$QEMU"
page_frames "$D/baseline-page-a.json"
sleep 30
consumer --hello-only > "$D/baseline-hello-b.json"
python3 -I "$ROOT/ci/cpu-snap.py" "$D/baseline-cpu-b.txt" "qemu=$QEMU"
page_frames "$D/baseline-page-b.json"
mem_snap "$D/baseline-mem.txt"
echo "  page fps without capture: $(python3 -I "$ROOT/ci/page-fps.py" "$D/baseline-page-a.json" "$D/baseline-page-b.json")"
python3 -I -c 'import json,sys; a=json.load(open(sys.argv[1]))["hello"]; b=json.load(open(sys.argv[2]))["hello"]; print("  posts/s without capture:", round((b["posts"]-a["posts"])/((b["clockUs"]-a["clockUs"])/1e6), 2))' "$D/baseline-hello-a.json" "$D/baseline-hello-b.json"

for spec in $VARIANTS; do
  IFS=: read -r name stream recording <<< "$spec"
  echo "::: $PROFILE $CONFIG $name: stream $stream, recording $recording, 60 fps"
  window "$D/$name-w1" "$stream" "$recording" 0
  window "$D/$name-w2" "$stream" "$recording" 0
  window "$D/$name-pbo" "$stream" "$recording" 2
  [ "$PROBE" = 1 ] && window "$D/$name-probe" "$stream" "$recording" 1
done
rm -f "$SOCK.read" "$SOCK.probe"
mem_snap "$D/mem-end.txt" full
echo "qemu still running: $(qemu_pid); capture errors: $(grep -c 'capture failed\|encoder error' "$AGENT_LOG")"
$ADB forward --remove tcp:9223 > /dev/null 2>&1 || true
stop_emulator
kill "$HTTP_PID" 2> /dev/null

echo "::: Analysis"
for dir in "$D"/*-w[12] "$D"/*-probe "$D"/*-pbo; do
  [ -f "$dir/stream.h264" ] || continue
  python3 -I "$ROOT/ci/analyze.py" stream "$dir/stream.h264" "$dir/stream.frames.csv" stream 2 30 \
    > "$dir/stream.analysis.json" 2>> "$dir/analysis.err"
  [ -f "$dir/recording.h264" ] && python3 -I "$ROOT/ci/analyze.py" stream "$dir/recording.h264" \
    "$dir/recording.frames.csv" recording 2 30 > "$dir/recording.analysis.json" 2>> "$dir/analysis.err"
done
python3 -I "$ROOT/ci/summary.py" "$OUT/$CONFIG" | tee "$OUT/$CONFIG/summary.md" || exit 1
# Keep normal and PBO stream/recording samples for the recording case.
find "$OUT/$CONFIG" \( -name '*.h264' -not -path '*/v4-w1/*' -not -path '*/v4-pbo/*' \) -delete
