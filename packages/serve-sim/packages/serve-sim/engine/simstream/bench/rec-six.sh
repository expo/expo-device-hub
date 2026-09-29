#!/bin/zsh
# rec-six.sh [approach numbers...]: record the Maps route (route-maps.json) through each of the six
# streaming approaches. The simulator runs on the remote laptop (SERVER); the recorder runs in
# headless Chrome on the Mini (VIEWER), reaching it over the tailnet. Before each run the Maps state is
# reset identically (prep-maps.sh), and only the approach under test is running.
#   1 simstream + Agent Hub (our fork)       2 WebRTC + Agent Hub (upstream)   3 HTTP + Agent Hub (upstream)
#   4 simstream engine page (WebSocket)      5 simstream + WebRTC data channel 6 simstream + WebRTC video track
approaches=(${@:-1 2 3 4 5 6})
HERE=${0:A:h}
[ -f "$HERE/../simstream.env" ] && set -a && . "$HERE/../simstream.env" && set +a
: "${SIMSTREAM_TAILNET:?set SIMSTREAM_TAILNET (see simstream.env.example)}"
SERVER=seth@sethwebster-expo.$SIMSTREAM_TAILNET; HOST=https://sethwebster-expo.$SIMSTREAM_TAILNET
VIEWER=seths-mac-mini; VNODE=/Users/sethwebster/.asdf/installs/nodejs/24.14.0/bin/node
SNODE_DIR=/Users/seth/.local/share/mise/installs/node/22.20.0/bin
FORK=@sethwebster/expo-agent-hub-simstream@0.3.4-simstream.2; UPSTREAM=@expo/serve-sim@0.4.0
OUT=/tmp/six; mkdir -p $OUT

python3 $HERE/route-maps.py > $HERE/route-maps.json
ssh $VIEWER 'mkdir -p ~/simrec/rec'
scp -q $HERE/record-fork.mjs $HERE/route-maps.json ${VIEWER}:simrec/
scp -q $HERE/gest.mjs $HERE/route-maps.json ${SERVER}:simp2p/

# Everything off on the laptop: serve-sim, bridges, engines. Then the standalone engine back up for
# the reset (a paused input-only client, so it captures nothing).
stop_all() {
  ssh $SERVER 'for p in 3200 8811 8812 8813 8816; do pids=$(lsof -tiTCP:$p -sTCP:LISTEN); [ -n "$pids" ] && kill $pids; done
    pkill -f "[s]erve-sim|[e]xpo-agent-hub-simstream" ; pkill -f "[s]imstream-engine"; sleep 2; true'
}
start_engine() {
  ssh $SERVER "cd ~/simp2p; (nohup ./bin/simstream-engine --udid \$(cat udid) --port 8811 >> engine.log 2>&1 &)
    for i in {1..40}; do nc -z 127.0.0.1 8811 && break; sleep 0.25; done"
}
bridge() { # port script mode env...
  local port=$1 script=$2 mode=$3; shift 3
  ssh $SERVER "cd ~/simp2p; (env $* nohup $SNODE_DIR/node $script 8811 $port $mode > bridge-rec-$port.log 2>&1 &); sleep 2"
}
serve_sim() { # package args...
  local pkg=$1; shift
  ssh $SERVER "export PATH=$SNODE_DIR:\$PATH; cd /tmp; (nohup npx -y $pkg $* -p 3200 \$(cat ~/simp2p/udid) > /tmp/rec-serve-sim.log 2>&1 &)
    for i in {1..120}; do curl -s -o /dev/null -m 1 http://127.0.0.1:3200/ && break; sleep 0.5; done; sleep 3"
}

for n in $approaches; do
  preload=""
  case $n in
    1) name="1 · simstream + Agent Hub (WebSocket)"; url=${HOST}:8448/;;
    2) name="2 · WebRTC + Agent Hub (upstream)"; url=${HOST}:8448/;;
    3) name="3 · HTTP + Agent Hub (upstream)"; url=${HOST}:8448/;;
    4) name="4 · simstream engine page (WebSocket)"; url=${HOST}:8443/; preload="localStorage.setItem('simstream.transitions','burst')";;
    5) name="5 · simstream + WebRTC data channel"; url=$HOST/;;
    6) name="6 · simstream + WebRTC video track (RTP)"; url=${HOST}:8446/;;
  esac
  echo "== $name"
  stop_all; start_engine
  ssh $SERVER 'zsh ~/simp2p/prep-maps.sh'
  case $n in
    1|2|3) ssh $SERVER 'pkill -f "[s]imstream-engine"; true'
           ssh $SERVER "/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8448 http://127.0.0.1:3200 >/dev/null";;
  esac
  case $n in
    1) serve_sim $FORK --transport http --codec simstream;;
    2) serve_sim $UPSTREAM --transport webrtc;;
    3) serve_sim $UPSTREAM --transport http;;
    5) bridge 8812 bridge.mjs nack DC_ACKS=unreliable SCTP_SACK_MS=5 DC_STUN=stun:stun.l.google.com:19302;;
    6) bridge 8816 bridge-rtp.mjs "" PACE_MBPS=300 PACE_INTERVAL_MS=1 DC_STUN=stun:stun.l.google.com:19302;;
  esac
  ssh $SERVER 'echo "   laptop load $(sysctl -n vm.loadavg)"'
  ssh $VIEWER "cd ~/simrec && ROUTE=./route-maps.json REC_PRELOAD=\"$preload\" caffeinate -i timeout 180 $VNODE record-fork.mjs '$url' '$name' rec/six-$n route 9380"
  scp -q ${VIEWER}:simrec/rec/six-$n.h264 ${VIEWER}:simrec/rec/six-$n.json $OUT/
  ssh $SERVER "grep -h 'viewer [0-9]*:' ~/simp2p/engine.log | tail -3 | cut -c1-160" 2>/dev/null | sed 's/^/   /'
done
stop_all
# Leave the spike services up afterwards: engine, data-channel bridge (/), video-track bridge (:8446).
start_engine
bridge 8812 bridge.mjs nack DC_ACKS=unreliable SCTP_SACK_MS=5 DC_STUN=stun:stun.l.google.com:19302
bridge 8816 bridge-rtp.mjs "" PACE_MBPS=300 PACE_INTERVAL_MS=1 DC_STUN=stun:stun.l.google.com:19302
