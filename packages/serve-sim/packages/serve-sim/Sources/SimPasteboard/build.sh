#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simpb}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BIN="$OUT_DIR/serve-sim-pasteboard"

# Build an arm64 simulator executable; it runs inside the sim via `simctl spawn`.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -fobjc-arc \
    -framework Foundation \
    -framework UIKit \
    -o "$BIN" \
    "$HERE/sim-pasteboard.m"

echo "Built: $BIN"
file "$BIN"
