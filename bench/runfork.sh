#!/bin/zsh
# runfork.sh <S|W|H> <light|heavy> <rep>: the forked serve-sim in one mode on :3200, measure, stop.
#   S = serve-sim + simstream engine, W = stock WebRTC H.264, H = stock HTTP/AVCC H.264
cfg=$1; scene=$2; rep=$3
BENCH=${0:A:h}
SS=/Users/sethwebster/Development/expo-device-hub-simstream/packages/serve-sim/packages/serve-sim
OUT=${FBENCH_OUT:-/tmp/fbench}; mkdir -p $OUT
stop_all() { for p in 3200; do pids=$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null; done; pkill -f 'dist/bin/simstream-engine' 2>/dev/null; sleep 2; }
stop_all
if [ "$scene" = heavy ]; then xcrun simctl openurl booted "http://127.0.0.1:8799/clock.html#heavy"; else xcrun simctl openurl booted "http://127.0.0.1:8799/clock.html"; fi
sleep 2
case $cfg in
  S) args=(--transport http --codec simstream); name="serve-sim + simstream";;
  W) args=(--transport webrtc --webrtc-codec h264); name="serve-sim WebRTC";;
  H) args=(--transport http --codec h264); name="serve-sim HTTP/AVCC";;
esac
(cd $SS && node dist/serve-sim.js $args -p 3200 > $OUT/srv-$cfg.log 2>&1 &)
url=http://localhost:3200/
for i in $(seq 1 40); do curl -s -o /dev/null -m 1 $url && break; sleep 0.5; done
sleep 2
out=$(timeout 80 node $BENCH/measure.mjs $url "$name | $scene | run $rep" 5 20 9351)
echo "$out" | tee -a $OUT/results.jsonl
stop_all
