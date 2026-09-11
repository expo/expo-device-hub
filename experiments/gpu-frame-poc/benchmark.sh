#!/usr/bin/env bash
# Start with a fresh emulator (one injected capture per process).
set -euo pipefail
cd "$(dirname "$0")"
rate=${1:-60}; name=${2:-capture}; frames=${3:-$((rate * 30))}
pid=$(cat emulator.pid)
for ((i=0;i<90;i++)); do
  kill -0 "$pid"
  if [[ $(timeout 3 "$ANDROID_HOME/platform-tools/adb" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; then
    break
  fi
  sleep 2
done
[[ $i -lt 90 ]] || { echo 'Android boot timed out'; exit 1; }
"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 shell am start -W -n dev.expo.gpupoc/.MainActivity
sleep 5
sudo .venv/bin/python inject.py "$pid" --script count-posts.js --seconds 20 > "$name-baseline.json"
cat "$name-baseline.json"
sudo .venv/bin/python inject.py "$pid" --fps "$rate" --frames "$frames" --seconds 35 \
  --output "$PWD/$name.h264" > "$name-inject.log" 2>&1
cat "$name-inject.log"
grep '\[gpu-poc\]' emulator.log > "$name-native.log"
cat "$name-native.log"
ffprobe -v error -count_frames -show_entries stream=width,height,pix_fmt,nb_read_frames \
  -of json "$name.h264" > "$name-probe.json"
