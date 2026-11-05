#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Next to the capability loader, which is where serve-sim looks for it.
OUT_DIR="${1:-$HERE/../../dist/capability-loader}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libServeSimTimeZone.dylib"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -O2 \
    -fobjc-arc \
    -Wall -Wextra -Werror \
    -framework Foundation \
    -install_name "@rpath/libServeSimTimeZone.dylib" \
    -o "$DYLIB" \
    "$HERE/ServeSimTimeZone.m"

echo "$DYLIB"
