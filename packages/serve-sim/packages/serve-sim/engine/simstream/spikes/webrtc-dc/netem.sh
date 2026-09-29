#!/bin/sh
# netem.sh <peer-ip> <loss-percent> <minutes>   (run with sudo)
#
# Emulates packet loss on this Mac's traffic to and from one peer only (e.g. the remote viewer's
# public address, which carries the Tailscale/WireGuard packets), for a fixed time, then removes
# itself. Uses dummynet via pf in an anchor under com.apple/*, which macOS's stock pf.conf already
# evaluates, so nothing in /etc is edited. Both transports under test ride the same outer packets,
# so they see identical loss.
set -eu
PEER=$1; LOSS=$2; MINUTES=$3
ANCHOR=com.apple/simstream-netem
PIPE=4711
PLR=$(awk "BEGIN { printf \"%.4f\", $LOSS / 100 }")
RULES=$(mktemp)
TOKEN=""

cleanup() {
  pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 || true
  dnctl pipe delete $PIPE >/dev/null 2>&1 || true
  [ -n "$TOKEN" ] && pfctl -X "$TOKEN" >/dev/null 2>&1 || true
  rm -f "$RULES"
  echo "netem: removed ($(date +%T))"
}
trap cleanup EXIT INT TERM

dnctl pipe $PIPE config plr "$PLR"
cat > "$RULES" <<EOF
dummynet out proto udp from any to $PEER pipe $PIPE
dummynet in proto udp from $PEER to any pipe $PIPE
EOF
pfctl -a "$ANCHOR" -f "$RULES"
TOKEN=$(pfctl -E 2>&1 | awk '/Token/ { print $NF }')
echo "netem: ${LOSS}% loss each way on UDP with $PEER for $MINUTES min (until $(date -v+${MINUTES}M +%T))"
sleep $(( MINUTES * 60 ))
