#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HERE/../../dist/simperm}/SimPermissionsFixture.app"
mkdir -p "$APP"
xcrun --sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=15.0 -fobjc-arc \
  -framework UIKit -framework Foundation -framework UserNotifications -framework Contacts \
  -framework AVFoundation -framework Photos -framework CoreLocation -framework EventKit \
  "$HERE/permission-fixture.m" -o "$APP/SimPermissionsFixture"
cp "$HERE/Info.plist" "$APP/Info.plist"
codesign --force --sign - "$APP"
echo "$APP"
