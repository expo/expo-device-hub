#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/capability-loader}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libServeSimProbe.dylib"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -O2 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -install_name "@rpath/libServeSimProbe.dylib" \
    -o "$DYLIB" \
    "$HERE/serve-sim-probe.c"

echo "$DYLIB"
