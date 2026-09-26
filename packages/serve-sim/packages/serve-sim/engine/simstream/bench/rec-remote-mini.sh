#!/bin/zsh
# rec-remote-mini.sh [modes...]: the fork runs on the Mac Mini (bound to its Tailscale IP, pinned to
# UDID); the recorder runs on REMOTE (off-prem) and reaches it over the network.
modes=(${@:-S W H})
cd ${0:A:h}
SERVER=seths-mac-mini; SERVER_NAME=seths-mac-mini.$SIMSTREAM_TAILNET; SERVER_IP=$SIMSTREAM_MINI_TS_IP
UDID=B3AFC702-8CB5-45BF-A221-99740EC51B4B; SNODE=/Users/sethwebster/.asdf/shims/node
REMOTE=seth@sethwebster-expo.$SIMSTREAM_TAILNET; RNODE=/Users/seth/.local/share/mise/installs/node/22.20.0/bin/node
URL=http://$SERVER_NAME:3200/
OUT=/tmp/fbench/remote-mini; mkdir -p $OUT
stop_server() { ssh $SERVER 'pids=$(lsof -tiTCP:3200 -sTCP:LISTEN); [ -n "$pids" ] && kill $pids; pkill -f dist/bin/simstream-engine; sleep 2; true'; }
for c in $modes; do
  case $c in
    S) args="--transport http --codec simstream"; name="serve-sim + simstream engine";;
    W) args="--transport webrtc --webrtc-codec h264"; name="serve-sim WebRTC (stock)";;
    H) args="--transport http --codec h264"; name="serve-sim HTTP/AVCC (stock)";;
  esac
  stop_server
  ssh $SERVER "cd ~/simfork && (nohup $SNODE dist/serve-sim.js $args --host $SERVER_IP -p 3200 $UDID > /tmp/fork-mini-$c.log 2>&1 &); for i in \$(seq 1 40); do curl -s -o /dev/null -m 1 http://$SERVER_IP:3200/ && break; sleep 0.5; done; $SNODE dist/serve-sim.js button home -d $UDID >/dev/null 2>&1; sleep 2; echo \"[$c] server load \$(sysctl -n vm.loadavg)\""
  ssh $REMOTE "cd ~/simbench && ROUTE=./route-mini.json REC_CHROME_ARGS=--unsafely-treat-insecure-origin-as-secure=$URL caffeinate -i timeout 150 $RNODE record-fork.mjs $URL '$name' rec/mini-$c route 9370"
  scp -q ${REMOTE}:simbench/rec/mini-${c}.h264 ${REMOTE}:simbench/rec/mini-${c}.json $OUT/
done
stop_server
