#!/bin/bash
# Builds the simstream video engine (vendored from github.com/…/simstream, see engine/simstream)
# into dist/bin/simstream-engine, next to its resource bundle. serve-sim launches it per device for
# `--codec simstream` and proxies /helper/<udid>/simstream to it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../dist/bin}"
swift build -c release --package-path "$HERE/simstream"
BIN="$(swift build -c release --package-path "$HERE/simstream" --show-bin-path)"
mkdir -p "$OUT_DIR"
cp -f "$BIN/simstream" "$OUT_DIR/simstream-engine"
rm -rf "$OUT_DIR/simstream_simstream.bundle"
cp -R "$BIN/simstream_simstream.bundle" "$OUT_DIR/"
echo "simstream engine → $OUT_DIR/simstream-engine"
