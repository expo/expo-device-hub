#!/bin/zsh
# rec-fork-all.sh <route|barcode> [modes...]: record the same script in each mode of the fork on :3200.
kind=$1; shift; modes=(${@:-S W H})
cd ${0:A:h}
SS=/Users/sethwebster/Development/expo-device-hub-simstream/packages/serve-sim/packages/serve-sim
OUT=/tmp/fbench/rec; mkdir -p $OUT
stop_all() { pids=$(lsof -tiTCP:3200 -sTCP:LISTEN 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null; pkill -f 'dist/bin/simstream-engine' 2>/dev/null; sleep 2; }
for c in $modes; do
  case $c in
    S) args=(--transport http --codec simstream); name="serve-sim + simstream engine";;
    W) args=(--transport webrtc --webrtc-codec h264); name="serve-sim WebRTC (stock)";;
    H) args=(--transport http --codec h264); name="serve-sim HTTP/AVCC (stock)";;
  esac
  stop_all
  (cd $SS && node dist/serve-sim.js $args -p 3200 > $OUT/srv-$c.log 2>&1 &)
  for i in $(seq 1 40); do curl -s -o /dev/null -m 1 http://localhost:3200/ && break; sleep 0.5; done
  if [ $kind = barcode ]; then xcrun simctl openurl booted "http://127.0.0.1:8799/clock.html#heavy"; sleep 6; else (cd $SS && node dist/serve-sim.js button home >/dev/null 2>&1); fi
  sleep 2
  timeout 120 node record-fork.mjs http://localhost:3200/ "$name" $OUT/$kind-$c $kind 9370
done
stop_all
