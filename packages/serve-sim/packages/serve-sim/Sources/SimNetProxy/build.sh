#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simnet}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimNetProxy.dylib"

# Apple silicon simulators run arm64 processes; no Intel slice is shipped.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -O2 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -Wl,-U,_serve_sim_startup \
    -install_name "@rpath/libSimNetProxy.dylib" \
    -o "$DYLIB" \
    "$HERE/SimNetProxy.c"

echo "Built: $DYLIB"
file "$DYLIB"

LINKED="$(otool -L "$DYLIB" | awk '/^\t/ {print $1}')"
if echo "$LINKED" | grep -v -e '^@rpath/libSimNetProxy\.dylib$' -e '^/usr/lib/libSystem\.B\.dylib$'; then
  echo "Startup capture must link only libSystem" >&2
  exit 1
fi
