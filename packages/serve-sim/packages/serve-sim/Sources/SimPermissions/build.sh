#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simperm}"
mkdir -p "$OUT_DIR"
BIN="$OUT_DIR/serve-sim-permissions"
# Simulator CLI entitlements belong in the Mach-O section, not the signing blob.
xcrun --sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=15.0 \
  -fobjc-arc -framework Foundation \
  -Wl,-sectcreate,__TEXT,__entitlements,"$HERE/entitlements.plist" \
  "$HERE/sim-permissions.m" -o "$BIN"
codesign --force --sign - "$BIN"
echo "Built: $BIN"
