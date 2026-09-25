#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/capability-loader}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
APP="$OUT_DIR/SimNetProbe.app"

rm -rf "$APP"
mkdir -p "$APP"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -fobjc-arc \
    -O2 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -framework UIKit -framework Foundation \
    -o "$APP/SimNetProbe" \
    "$HERE/simnet-probe.m"

cp "$HERE/Info.plist" "$APP/Info.plist"
codesign --force --sign - --timestamp=none "$APP" >/dev/null

echo "$APP"
