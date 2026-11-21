#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Next to the capability loader, which is where serve-sim looks for it.
OUT_DIR="${1:-$HERE/../../dist/capability-loader}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libServeSimClock.dylib"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -O2 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -Wl,-U,_serve_sim_startup \
    -Wl,-U,_serve_sim_set_wall_clock_offset \
    -install_name "@rpath/libServeSimClock.dylib" \
    -o "$DYLIB" \
    "$HERE/ServeSimClock.c"

# Inserted at exec into every process, like the loader: anything beyond libSystem
# crash-loops system daemons, so fail the build rather than ship it.
LINKED="$(otool -L "$DYLIB" | awk '/^\t/ {print $1}')"
if echo "$LINKED" | grep -v -e '^@rpath/libServeSimClock\.dylib$' -e '^/usr/lib/libSystem\.B\.dylib$'; then
  echo "The clock startup capability must link only libSystem" >&2
  exit 1
fi

echo "$DYLIB"
