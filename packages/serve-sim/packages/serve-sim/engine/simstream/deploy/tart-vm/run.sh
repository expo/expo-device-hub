#!/bin/zsh
# Run the serve-sim fork (simstream engine) inside a Tart macOS VM on this Mac, reachable directly
# from the internet: router WAN $VM_WAN_PORT -> bridged VM :443 (Caddy, DNS-01 cert) -> serve-sim.
# No tunnel and no hop through the host.
#
# Prereqs on the host: tart; the VM image (tart clone ghcr.io/cirruslabs/macos-tahoe-xcode:latest
# tahoe-xcode); ~/simfork holding the built fork (dist/ + node_modules/ws) and guest-bin/caddy (Caddy
# with the Cloudflare DNS module: https://caddyserver.com/api/download?os=darwin&arch=arm64&p=github.com/caddy-dns/cloudflare);
# ~/.config/simstream/{cloudflare-token,vm-token}. Router: forward WAN $VM_WAN_PORT to the VM's
# reserved LAN IP on 443 (DHCP-reserve the VM's MAC). DNS: cloudflare-dns-record.sh.
set -euo pipefail
VM=${VM:-tahoe-xcode}; IFACE=${IFACE:-en0}
SHARE="/Volumes/My Shared Files/simfork"

tart set $VM --cpu 8 --memory 16384
(nohup tart run $VM --no-graphics --net-bridged=$IFACE --dir=simfork:$HOME/simfork > ~/Library/Logs/$VM-run.log 2>&1 &)
for i in {1..60}; do tart exec $VM true 2>/dev/null && break; sleep 3; done
echo "VM LAN IP: $(tart ip $VM --resolver=arp)"

# Simulator: iPhone 17 Pro on the newest iOS runtime in the image.
tart exec $VM sh -c '
  U=$(xcrun simctl list devices | grep simstream-vm | grep -oE "[0-9A-F-]{36}" | head -1)
  [ -n "$U" ] || U=$(xcrun simctl create simstream-vm com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
                      $(xcrun simctl list runtimes | grep -oE "com.apple.CoreSimulator.SimRuntime.iOS-[0-9-]+" | tail -1))
  xcrun simctl boot $U 2>/dev/null || true; xcrun simctl bootstatus $U -b >/dev/null; echo $U > /tmp/simvm-udid'

# Secrets into the guest (owner-only), then serve-sim on guest loopback and Caddy on :443.
umask 077
tart exec $VM sh -c "cat > ~/.cf-token" < ~/.config/simstream/cloudflare-token
T=$(cat ~/.config/simstream/vm-token)
tart exec $VM sh -c "cp '$SHARE/guest-bin/caddy' '$SHARE/guest-bin/Caddyfile' ~/"
(tart exec $VM sh -c "cd '$SHARE' && SERVE_SIM_TOKEN=$T SERVE_SIM_DEBUG_SIMSTREAM=1 nohup node dist/serve-sim.js \
    --transport http --codec simstream --require-token -p 3200 \$(cat /tmp/simvm-udid) > /tmp/fork.log 2>&1 < /dev/null &" &)
(tart exec $VM sh -c 'CF_API_TOKEN=$(cat ~/.cf-token) nohup ~/caddy run --config ~/Caddyfile --adapter caddyfile > ~/caddy.log 2>&1 < /dev/null &' &)
sleep 20
echo "open: https://vm.simstream.sethwebster.com:${VM_WAN_PORT:-9443}/?token=<~/.config/simstream/vm-token>"
