#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simpb}"
APP="$OUT_DIR/PasteboardFixture.app"
mkdir -p "$APP"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -fobjc-arc \
    -framework Foundation \
    -framework UIKit \
    -o "$APP/PasteboardFixture" \
    "$HERE/main.m"

cp "$HERE/Info.plist" "$APP/Info.plist"
echo "Built: $APP"
file "$APP/PasteboardFixture"
