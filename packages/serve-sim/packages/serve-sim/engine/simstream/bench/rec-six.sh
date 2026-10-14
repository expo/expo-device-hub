#!/bin/zsh
# rec-six.sh [approach numbers...]: record the Maps route (route-maps.json) through each of the six
# streaming approaches. The simulator runs on the remote laptop (SERVER); the recorder runs in
# headless Chrome on this machine (VIEWER=local, the default) or over ssh on VIEWER, reaching it over the tailnet. Before each run the Maps state is
# reset identically (prep-maps.sh), and only the approach under test is running.
#   1 simstream + Agent Hub (our fork)       2 WebRTC + Agent Hub (upstream)   3 HTTP + Agent Hub (upstream)
#   4 simstream engine page (WebSocket)      5 simstream + WebRTC data channel 6 simstream + WebRTC video track
#   7 Agent Hub, simstream over its WebSocket 8 Agent Hub, simstream over WebRTC (RTP): the fork's own
#     transport switch (?simstream=), serve-sim's own input, from AGENT_HUB (default $FORK; a path to an
#     installed serve-sim.js on the laptop runs that build instead)
# The simstream panes (1, 4, 5, 6) differ only in transport: all inject touches through the engine
# (pane 1 via the engine-input.js preload) and all use the same direct tailnet path (the WebRTC
# bridges bind to the laptop's tailnet address, with no STUN). ROUNDS=N records every approach N times,
# interleaved (round by round), as six-<n>-r<round>. LOSSES="0 1 2" also records each approach at each
# packet loss (percent, each way, on this machine's traffic with the laptop: ../spikes/webrtc-dc/netem.sh,
# on only while the recorder runs), as six-<n>-l<loss>-r<round>; needs VIEWER=local.
approaches=($@); (( $# )) || approaches=(1 2 3 4 5 6)
ROUNDS=${ROUNDS:-1}; LOSSES=(${=LOSSES:-0})
HERE=${0:A:h}; NETEM=$HERE/../spikes/webrtc-dc/netem.sh
(( ${#LOSSES} > 1 || LOSSES[1] > 0 )) && trap "zsh $NETEM off" EXIT
[ -f "$HERE/../simstream.env" ] && set -a && . "$HERE/../simstream.env" && set +a
: "${SIMSTREAM_TAILNET:?set SIMSTREAM_TAILNET (see simstream.env.example)}"
SERVER=seth@sethwebster-expo.$SIMSTREAM_TAILNET; HOST=https://sethwebster-expo.$SIMSTREAM_TAILNET
VIEWER=${VIEWER:-local}; VNODE=/Users/sethwebster/.asdf/installs/nodejs/24.14.0/bin/node
SNODE_DIR=/Users/seth/.local/share/mise/installs/node/22.20.0/bin
FORK=@sethwebster/expo-agent-hub-simstream@0.3.4-simstream.2; UPSTREAM=@expo/serve-sim@0.4.0
OUT=${SIX_OUT:-/tmp/six}; mkdir -p $OUT

python3 $HERE/route-maps.py > $HERE/route-maps.json
[[ $VIEWER == local ]] || { ssh $VIEWER 'mkdir -p ~/simrec/rec'
  scp -q $HERE/record-fork.mjs $HERE/engine-input.js $HERE/route-maps.json ${VIEWER}:simrec/; }
scp -q $HERE/gest.mjs $HERE/prep-maps.sh $HERE/route-maps.json ${SERVER}:simp2p/

# Everything off on the laptop: serve-sim, bridges, engines. Then the standalone engine back up for
# the reset (a paused input-only client, so it captures nothing).
stop_all() {
  ssh $SERVER 'for p in 3200 8811 8812 8813 8816; do pids=$(lsof -tiTCP:$p -sTCP:LISTEN); [ -n "$pids" ] && kill $pids; done
    pkill -f "[s]erve-sim|[e]xpo-agent-hub-simstream" ; pkill -f "[s]imstream-engine"; sleep 2; true'
}
# ENGINE_BIN (a folder in ~/simp2p on the laptop) and ENGINE_ENV (e.g. SIMSTREAM_FIXED_BITRATE=8000000)
# pick the engine build and its settings for panes 4, 5 and 6.
start_engine() {
  ssh $SERVER "cd ~/simp2p; (env ${ENGINE_ENV:-} nohup ./${ENGINE_BIN:-bin}/simstream-engine --udid \$(cat udid) --port 8811 >> engine.log 2>&1 &)
    for i in {1..40}; do nc -z 127.0.0.1 8811 && break; sleep 0.25; done"
}
bridge() { # port script mode env...
  local port=$1 script=$2 mode=$3; shift 3
  ssh $SERVER "cd ~/simp2p; echo run \$(date) >> bridge-rec-$port.log; (env $* nohup $SNODE_DIR/node $script 8811 $port $mode >> bridge-rec-$port.log 2>&1 &); sleep 2"
}
serve_sim() { # package (or path to serve-sim.js) args...
  local pkg=$1 run="npx -y $1"; shift
  [[ $pkg == */serve-sim.js ]] && run="node $pkg"
  ssh $SERVER "export PATH=$SNODE_DIR:\$PATH; cd /tmp; (nohup $run $* -p 3200 \$(cat ~/simp2p/udid) > /tmp/rec-serve-sim.log 2>&1 &)
    for i in {1..120}; do curl -s -o /dev/null -m 1 http://127.0.0.1:3200/ && break; sleep 0.5; done; sleep 3"
}

TAILNET_IP=$(ssh $SERVER '/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4')
TAILNET_IPS=$TAILNET_IP,$(ssh $SERVER '/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -6')   # loss on both
DC_ENV="DC_BIND=$TAILNET_IP"

for round in {1..$ROUNDS}; do for loss in $LOSSES; do for n in $approaches; do
  preload=""; tag=six-$n; (( ${#LOSSES} > 1 )) && tag=$tag-l$loss; (( ROUNDS > 1 )) && tag=$tag-r$round
  case $n in
    1) name="1 · simstream + Agent Hub (WebSocket)"; url=${HOST}:8448/; preload=engine-input.js;;
    2) name="2 · WebRTC + Agent Hub (upstream)"; url=${HOST}:8448/;;
    3) name="3 · HTTP + Agent Hub (upstream)"; url=${HOST}:8448/;;
    4) name="4 · simstream engine page (WebSocket)"; url=${HOST}:8443/; preload="localStorage.setItem('simstream.transitions','burst')";;
    5) name="5 · simstream + WebRTC data channel"; url=$HOST/;;
    6) name="6 · simstream + WebRTC video track (RTP)"; url=${HOST}:8446/;;
    7) name="7 · Agent Hub, simstream WebSocket"; url="${HOST}:8448/?simstream=websocket";;
    8) name="8 · Agent Hub, simstream WebRTC (RTP)"; url="${HOST}:8448/?simstream=rtp";;
  esac
  (( ${#LOSSES} > 1 )) && name="$name · $loss% loss"
  echo "== round $round: $name"
  stop_all; start_engine
  ssh $SERVER 'zsh ~/simp2p/prep-maps.sh'
  case $n in
    1|2|3|7|8) ssh $SERVER 'pkill -f "[s]imstream-engine"; true'
           ssh $SERVER "/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8448 http://127.0.0.1:3200 >/dev/null";;
  esac
  case $n in
    1) serve_sim $FORK --transport http --codec simstream;;
    7|8) serve_sim ${AGENT_HUB:-$FORK} --transport http --codec simstream;;
    2) serve_sim $UPSTREAM --transport webrtc;;
    3) serve_sim $UPSTREAM --transport http;;
    5) bridge 8812 bridge.mjs nack DC_ACKS=unreliable SCTP_SACK_MS=5 $DC_ENV;;
    6) bridge 8816 bridge-rtp.mjs "" PACE_MBPS=300 PACE_INTERVAL_MS=1 $DC_ENV;;
  esac
  ssh $SERVER 'echo "   laptop load $(sysctl -n vm.loadavg)"'
  if [[ $VIEWER == local ]]; then
    echo "   viewer load $(sysctl -n vm.loadavg)"
    (( loss > 0 )) && zsh $NETEM $TAILNET_IPS $loss
    ping -i 0.2 -q $TAILNET_IP > $OUT/$tag.ping 2>&1 & pinger=$!   # proof the loss was in effect
    ROUTE=$HERE/route-maps.json REC_PRELOAD=$preload caffeinate -i timeout 180 $VNODE $HERE/record-fork.mjs $url $name $OUT/$tag route 9380
    kill -INT $pinger; wait $pinger 2>/dev/null; echo "   ping during the run: $(grep -o '[0-9.]*% packet loss' $OUT/$tag.ping)"
    (( loss > 0 )) && zsh $NETEM off
  else
    ssh $VIEWER "cd ~/simrec && ROUTE=./route-maps.json REC_PRELOAD=\"$preload\" caffeinate -i timeout 180 $VNODE record-fork.mjs '$url' '$name' rec/$tag route 9380"
    scp -q ${VIEWER}:simrec/rec/$tag.h264 ${VIEWER}:simrec/rec/$tag.json $OUT/
  fi
  ssh $SERVER "grep -h 'viewer [0-9]*:' ~/simp2p/engine.log | tail -3 | cut -c1-160" 2>/dev/null | sed 's/^/   /'
done; done; done
stop_all
# Leave the spike services up afterwards: engine, data-channel bridge (/), video-track bridge (:8446).
start_engine
bridge 8812 bridge.mjs nack DC_ACKS=unreliable SCTP_SACK_MS=5 $DC_ENV
bridge 8816 bridge-rtp.mjs "" PACE_MBPS=300 PACE_INTERVAL_MS=1 $DC_ENV
