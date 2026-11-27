#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simkc}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimKeychain.dylib"

# The capability loader dlopens this inside the app, so it runs with the app's
# keychain entitlements and may link Foundation and Security.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fobjc-arc \
    -O2 \
    -Wall -Wextra -Werror -Wshadow \
    -framework Foundation \
    -framework Security \
    -install_name "@rpath/libSimKeychain.dylib" \
    -o "$DYLIB" \
    "$HERE/sim-keychain.m"

echo "Built: $DYLIB"
file "$DYLIB"
