#!/bin/sh
# netem.sh <peer-ip> <loss-percent> <minutes>   (run with sudo)
#
# Emulates packet loss on this Mac's traffic to and from one peer only, for a fixed time, then
# removes itself. For a Tailscale peer pass its Tailscale IP (100.x): the tunnel's outer UDP is sent
# by the Tailscale network extension and bypasses pf, but the inner packets cross the kernel's utun
# interface, where pf sees them. All protocols are matched, so TCP (WebSocket) and UDP (WebRTC)
# take the same loss, and ping shows it. Uses dummynet via pf in an anchor under com.apple/*, which macOS's stock /etc/pf.conf
# evaluates. pf's main ruleset is empty until something loads it, so the stock pf.conf is loaded
# first (nothing in /etc is edited). Both transports under test ride the same outer packets,
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

pfctl -q -f /etc/pf.conf 2>/dev/null   # main ruleset with the com.apple/* anchors (stock config)
dnctl pipe $PIPE config plr "$PLR"
cat > "$RULES" <<EOF
dummynet out from any to $PEER pipe $PIPE
dummynet in from $PEER to any pipe $PIPE
EOF
pfctl -a "$ANCHOR" -f "$RULES"
TOKEN=$(pfctl -E 2>&1 | awk '/Token/ { print $NF }')
echo "netem: ${LOSS}% loss each way on all traffic with $PEER for $MINUTES min (until $(date -v+${MINUTES}M +%T))"
echo "netem: pipe:"; dnctl pipe show $PIPE 2>&1 | head -3
echo "netem: rules:"; pfctl -a "$ANCHOR" -s dummynet 2>/dev/null
echo "netem: main ruleset references the anchor: $(pfctl -s dummynet 2>/dev/null | grep -c 'com.apple')"
sleep $(( MINUTES * 60 ))
