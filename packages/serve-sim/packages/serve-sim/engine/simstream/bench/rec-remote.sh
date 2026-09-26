#!/bin/zsh
# rec-remote.sh [modes...]: record the route from a remote viewer over the network. The fork runs here
# bound to this machine's Tailscale IP; the recorder (headless Chrome + CDP input) runs on REMOTE.
modes=(${@:-S W H})
cd ${0:A:h}
# Machine-specific values (SIMSTREAM_*) come from ../simstream.env or the environment.
[ -f "${0:A:h}/../simstream.env" ] && set -a && . "${0:A:h}/../simstream.env" && set +a
: "${SIMSTREAM_TAILNET:?set SIMSTREAM_TAILNET (see simstream.env.example)}"
SS=/Users/sethwebster/Development/expo-device-hub-simstream/packages/serve-sim/packages/serve-sim
REMOTE=${REMOTE:-seth@sethwebster-expo.$SIMSTREAM_TAILNET}
RNODE=${RNODE:-/Users/seth/.local/share/mise/installs/node/22.20.0/bin/node}
HOST_IP=$(tailscale ip -4); HOST_NAME=seth-webster-m4.$SIMSTREAM_TAILNET
URL=http://$HOST_NAME:3200/
OUT=/tmp/fbench/remote; mkdir -p $OUT
stop_all() { pids=$(lsof -tiTCP:3200 -sTCP:LISTEN 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null; pkill -f 'dist/bin/simstream-engine' 2>/dev/null; sleep 2; }
for c in $modes; do
  case $c in
    S) args=(--transport http --codec simstream); name="serve-sim + simstream engine";;
    W) args=(--transport webrtc --webrtc-codec h264); name="serve-sim WebRTC (stock)";;
    H) args=(--transport http --codec h264); name="serve-sim HTTP/AVCC (stock)";;
  esac
  stop_all
  (cd $SS && node dist/serve-sim.js $args --host $HOST_IP -p 3200 > $OUT/srv-$c.log 2>&1 &)
  for i in $(seq 1 40); do curl -s -o /dev/null -m 1 http://$HOST_IP:3200/ && break; sleep 0.5; done
  (cd $SS && node dist/serve-sim.js button home >/dev/null 2>&1); sleep 2
  echo "[$c] load $(sysctl -n vm.loadavg)"
  ssh $REMOTE "cd ~/simbench && REC_CHROME_ARGS=--unsafely-treat-insecure-origin-as-secure=$URL timeout 120 $RNODE record-fork.mjs $URL '$name (remote)' rec/route-$c route 9370"
  scp -q ${REMOTE}:simbench/rec/route-${c}.h264 ${REMOTE}:simbench/rec/route-${c}.json $OUT/
done
stop_all
