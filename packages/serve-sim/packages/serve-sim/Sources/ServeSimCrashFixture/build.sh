#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/capability-loader}"
APP="$OUT_DIR/ServeSimCrashFixture.app"

rm -rf "$APP"
mkdir -p "$APP"
cp "$HERE/Info.plist" "$APP/Info.plist"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
xcrun --sdk iphonesimulator swiftc \
  -sdk "$SDK" \
  -target arm64-apple-ios18.0-simulator \
  -module-name ServeSimCrashFixture \
  "$HERE/AppDelegate.swift" \
  "$HERE/Crash.swift" \
  -o "$APP/ServeSimCrashFixture"

codesign --force --sign - --timestamp=none "$APP" >/dev/null
echo "$APP"
