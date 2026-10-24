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

# Pasteboard reads need an installed app identity so simctl can grant permission. Keep the
# standalone binary for writes and change counts, which work without that permission.
# A user can launch the installed app from the Home screen with no arguments, so the tool
# writes only with --write.
APP="$OUT_DIR/ServeSimPasteboard.app"
mkdir -p "$APP"
cp "$HERE/Info.plist" "$APP/Info.plist"
cp "$BIN" "$APP/serve-sim-pasteboard"
cp "$HERE"/Icons/AppIcon*.png "$APP/"
codesign --force --sign - "$APP"
echo "Built: $APP"
