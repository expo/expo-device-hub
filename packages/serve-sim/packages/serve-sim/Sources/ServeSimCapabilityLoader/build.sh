#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/capability-loader}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libServeSimCapabilityLoader.dylib"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -O2 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -install_name "@rpath/libServeSimCapabilityLoader.dylib" \
    -o "$DYLIB" \
    "$HERE/serve-sim-capability-loader.c"

# This image is inserted into every process in the simulator. Anything beyond
# libSystem crash-loops system daemons, so fail the build rather than ship it.
LINKED="$(otool -L "$DYLIB" | grep $'^\t' | awk '{print $1}' | sort -u)"
UNEXPECTED="$(echo "$LINKED" | grep -v -e '^@rpath/libServeSimCapabilityLoader\.dylib$' -e '^/usr/lib/libSystem\.B\.dylib$' || true)"
if [ -n "$UNEXPECTED" ]; then
  echo "CapabilityLoader links more than libSystem:" >&2
  echo "$UNEXPECTED" >&2
  exit 1
fi

echo "$DYLIB"
