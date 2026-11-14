#!/bin/bash
# Test PBO resizing while both consumers retain frames on an isolated EAS foldable.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/ci/lib.sh"
D="$OUT/fold"
mkdir -p "$D"
trap 'tar czf "$ROOT/results-fold.tar.gz" -C "$ROOT" out/fold logs' EXIT
AGENT_LOG="$LOGS/agent-fold.log"
install_ws
start_http
launch_emulator pixel_9_pro_fold_base fold -gpu lavapipe
wait_boot "$(now_ms)" "$D/boot.json"
wait_socket
prepare_chrome
open_page "$PAGE"
echo 1 > "$SOCK.pbo"
node "$ROOT/ci/consumer.mjs" --capture "$CAP" --socket "$SOCK" --role recording --max-size 0 --fps 60 --seconds 26 --out "$D/recording" > "$D/recording.json" &
recording_pid=$!
node "$ROOT/ci/consumer.mjs" --capture "$CAP" --socket "$SOCK" --role stream --max-size 1280 --fps 60 --seconds 25 --out "$D/stream" > "$D/stream.json" &
stream_pid=$!
sleep 5
$ADB emu fold | tee "$D/fold.txt"
sleep 7
$ADB shell wm size > "$D/fold-size.txt"
$ADB emu unfold | tee "$D/unfold.txt"
sleep 7
$ADB shell wm size > "$D/unfold-size.txt"
wait "$recording_pid" "$stream_pid"
python3 -I - "$D" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
s=json.loads((p/'stream.json').read_text())
r=json.loads((p/'recording.json').read_text())
assert s['frames'] > 0 and r['frames'] > 0, (s,r)
sizes={(v['width'],v['height']) for v in s['configured']}
placements={json.dumps(v['details'].get('contentRect'),sort_keys=True) for v in r['configured']}
assert len(sizes) > 1, s
assert len(placements) > 1, r
print('PBO fold/unfold passed:', s['frames'], 'stream frames,', r['frames'], 'recording frames, sizes',sizes,'placements',placements)
PY
ffmpeg -v error -i "$D/recording.h264" -f null -
stop_emulator
kill "$HTTP_PID" || true
