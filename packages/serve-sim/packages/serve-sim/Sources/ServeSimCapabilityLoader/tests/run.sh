#!/bin/bash
# Compiles and runs the capability loader parsing tests on the host, then runs clang's
# static analyzer over the shipped source. The dylib itself is built for the
# simulator; this builds the same code for the host so it can be exercised
# without a device.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

xcrun clang -dynamiclib -O1 -Wall -Wextra -Werror \
    -o "$OUT_DIR/libServeSimHostProbe.dylib" \
    "$HERE/host-probe.c"

xcrun clang \
    -std=c11 \
    -g -O1 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -fsanitize=address,undefined \
    -fno-omit-frame-pointer \
    -fno-sanitize-recover=all \
    -DSERVE_SIM_TEST_DYLIB="\"$OUT_DIR/libServeSimHostProbe.dylib\"" \
    -o "$OUT_DIR/capability-loader-test" \
    "$HERE/capability-loader-test.c"

"$OUT_DIR/capability-loader-test"

# clang --analyze exits 0 even when it reports, and -Werror does not change that,
# so the findings themselves are the signal.
ANALYSIS="$OUT_DIR/analysis.txt"
if ! xcrun clang \
    --analyze \
    -Xclang -analyzer-output=text \
    -std=c11 \
    -Wall -Wextra -Wconversion -Wshadow \
    -o "$OUT_DIR/analysis" \
    "$HERE/../serve-sim-capability-loader.c" > "$ANALYSIS" 2>&1; then
  cat "$ANALYSIS"
  echo "clang analyzer failed" >&2
  exit 1
fi

if [ -s "$ANALYSIS" ]; then
  echo "analyzer findings:"
  cat "$ANALYSIS"
  exit 1
fi

echo "analyzer clean"
