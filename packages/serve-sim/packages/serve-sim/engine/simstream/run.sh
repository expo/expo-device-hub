#!/bin/sh
# Build, sign, and run simstream.
#
# `swift build` produces an ad-hoc signed binary, which the macOS application firewall silently
# blocks for anything other than loopback — other devices (and even this Mac's own LAN IP) get
# "can't connect". A real signing identity is auto-allowed when "Automatically allow downloaded
# signed software" is on (the default).
#
# Override the identity with SIMSTREAM_SIGN_IDENTITY="…"; set it to "-" to skip signing.
set -e
cd "$(dirname "$0")"

swift build -c release
binary=.build/release/simstream

find_identity() { security find-identity -v -p codesigning | sed -n "s/.*\"\($1:.*\)\"/\1/p" | head -1; }
identity=${SIMSTREAM_SIGN_IDENTITY:-$(find_identity "Developer ID Application")}
identity=${identity:-$(find_identity "Apple Development")}

if [ "$identity" = "-" ] || [ -z "$identity" ]; then
  echo "[simstream] no signing identity; only localhost will be reachable" >&2
else
  codesign -f -s "$identity" "$binary" 2>/dev/null
  echo "[simstream] signed with $identity" >&2
fi

exec "$binary" "$@"
