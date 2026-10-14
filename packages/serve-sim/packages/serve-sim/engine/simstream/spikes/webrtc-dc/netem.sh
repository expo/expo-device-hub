#!/bin/zsh
# netem.sh <peer-ip[,peer-ip...]> <loss-percent> [delay-ms]   (needs sudo for pfctl and dnctl)
# netem.sh off
#
# Packet loss (and optional one-way delay), each way, on all of this Mac's traffic with one peer. For
# a Tailscale peer pass both its 100.x and fd7a: addresses (WebRTC may pick either): pf sees the
# inner packets on utun, so TCP (WebSocket) and UDP (WebRTC) take the same loss. Dummynet rules only
# take effect in pf's main ruleset (inside a com.apple/* anchor they're loaded but never applied), so
# this rebuilds the live main ruleset, with every anchor it already references (Internet Sharing,
# VPNs), plus the dummynet rules. `off` reloads it without them. Check with ping: 10% each way loses
# ~19% of pings.
set -eu
PIPE_OUT=4711; PIPE_IN=4712
live() { # the live main ruleset, in pf.conf order, without our rules
  local rules=$(sudo -n /sbin/pfctl -s rules 2>/dev/null)
  print -r -- "$rules" | grep '^scrub' || true
  sudo -n /sbin/pfctl -s nat 2>/dev/null
  sudo -n /sbin/pfctl -s dummynet 2>/dev/null | grep -v "pipe $PIPE_OUT\|pipe $PIPE_IN" || true
  print -r -- "$rules" | grep -v '^scrub' || true
}
if [[ $1 == off ]]; then
  live | sudo -n /sbin/pfctl -q -f - 2>&1 | grep -v 'ALTQ\|flushing\|present in the main\|pf.conf for further\|^$' || true
  sudo -n /usr/sbin/dnctl pipe delete $PIPE_OUT 2>/dev/null || true
  sudo -n /usr/sbin/dnctl pipe delete $PIPE_IN 2>/dev/null || true
  echo "netem: off"; exit 0
fi
PEER="{ ${1//,/, } }"; PLR=$(awk "BEGIN { printf \"%.4f\", $2 / 100 }"); DELAY=${3:-0}
sudo -n /usr/sbin/dnctl pipe $PIPE_OUT config plr $PLR delay $DELAY
sudo -n /usr/sbin/dnctl pipe $PIPE_IN config plr $PLR delay $DELAY
conf=$(live)
{ print -r -- "$conf" | grep -v '^anchor\|^load anchor' | grep -v '^scrub'
  echo "dummynet out from any to $PEER pipe $PIPE_OUT"
  echo "dummynet in from $PEER to any pipe $PIPE_IN"
  print -r -- "$conf" | grep '^anchor\|^load anchor'
} > /tmp/netem-body.conf
{ print -r -- "$conf" | grep '^scrub' || true; cat /tmp/netem-body.conf; } | sudo -n /sbin/pfctl -q -f - 2>&1 | grep -v 'ALTQ\|flushing\|present in the main\|pf.conf for further\|^$' || true
echo "netem: $2% loss each way, ${DELAY} ms delay each way, with $PEER"
