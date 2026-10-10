#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simpb}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
READER="$OUT_DIR/libSimPasteboardReader.dylib"

# The capability loader dlopens this inside the app container, so
# unlike a global insert it can link UIKit.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fobjc-arc \
    -framework UIKit \
    -install_name "@rpath/libSimPasteboardReader.dylib" \
    -o "$READER" \
    "$HERE/sim-pasteboard-reader.m"

echo "Built: $READER"
file "$READER"
