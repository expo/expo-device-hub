#!/bin/bash
set -euo pipefail
: "${DUO_E2E_DEVICE:?Set DUO_E2E_DEVICE to the booted Duo UDID}"
fixture_dir="$(cd "$(dirname "$0")" && pwd)"
fixture_build="$(mktemp -d /tmp/serve-sim-duo-fixture.XXXXXX)"
trap 'rm -rf "$fixture_build"' EXIT
fixture_app="$fixture_build/DuoFixture.app"
mkdir -p "$fixture_app"
xcrun --sdk iphonesimulator swiftc -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -target arm64-apple-ios18.0-simulator "$fixture_dir/main.swift" -o "$fixture_app/DuoFixture"
cat > "$fixture_app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.expo.serve-sim.duo-fixture</string>
<key>CFBundleExecutable</key><string>DuoFixture</string><key>CFBundleName</key><string>Duo Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/><key>UISceneConfigurations</key><dict/></dict>
<key>UILaunchScreen</key><dict/><key>UIRequiresFullScreen</key><true/>
<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string><string>UIInterfaceOrientationLandscapeLeft</string><string>UIInterfaceOrientationLandscapeRight</string><string>UIInterfaceOrientationPortraitUpsideDown</string></array>
</dict></plist>
PLIST
codesign --force --sign - "$fixture_app"
xcrun simctl install "$DUO_E2E_DEVICE" "$fixture_app"
xcrun simctl launch "$DUO_E2E_DEVICE" dev.expo.serve-sim.duo-fixture
