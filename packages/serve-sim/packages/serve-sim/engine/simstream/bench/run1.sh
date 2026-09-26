#!/bin/zsh
# run1.sh <A|B|C|D> <light|heavy> <rep>: start exactly one server, measure, stop it, append JSON.
cfg=$1; scene=$2; rep=$3
stop_all() { for p in 8795 3200; do pids=$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null; done; sleep 2; }
stop_all
if [ "$scene" = heavy ]; then xcrun simctl openurl booted "http://127.0.0.1:8799/clock.html#heavy"; else xcrun simctl openurl booted "http://127.0.0.1:8799/clock.html"; fi
sleep 2
case $cfg in
  A) (cd /Users/sethwebster/Development/simstream && .build/release/simstream --port 8795 > /tmp/bench/srv-$cfg.log 2>&1 &); url=http://localhost:8795/; name="simstream (default)";;
  B) (cd /Users/sethwebster/Development/simstream && .build/release/simstream --port 8795 --bitrate 6 > /tmp/bench/srv-$cfg.log 2>&1 &); url=http://localhost:8795/; name="simstream @6Mbps";;
  C) (cd /tmp/bench && npx -y @expo/serve-sim@0.3.4 --transport webrtc --webrtc-codec h264 -p 3200 > /tmp/bench/srv-$cfg.log 2>&1 &); url=http://localhost:3200/; name="serve-sim WebRTC";;
  D) (cd /tmp/bench && npx -y @expo/serve-sim@0.3.4 --transport http --codec h264 -p 3200 > /tmp/bench/srv-$cfg.log 2>&1 &); url=http://localhost:3200/; name="serve-sim HTTP/AVCC";;
esac
for i in $(seq 1 40); do curl -s -o /dev/null -m 1 $url && break; sleep 0.5; done
sleep 2
out=$(timeout 80 node /tmp/bench/measure.mjs $url "$name | $scene | run $rep" 5 20 9351)
echo "$out" | tee -a /tmp/bench/results.jsonl
stop_all
