#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simcam}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimCameraInjector.dylib"

# Apple silicon simulators run arm64 processes; no Intel slice is shipped.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fobjc-arc \
    -fmodules \
    -fobjc-weak \
    -framework Foundation \
    -framework UIKit \
    -framework AVFoundation \
    -framework CoreImage \
    -framework CoreMedia \
    -framework CoreMotion \
    -framework CoreVideo \
    -framework CoreGraphics \
    -framework IOSurface \
    -framework QuartzCore \
    -install_name "@rpath/libSimCameraInjector.dylib" \
    -o "$DYLIB" \
    "$HERE/SimCameraInjector.m" \
    "$HERE/SimCamLog.m" \
    "$HERE/SimCamFakes.m" \
    "$HERE/SimCamFrameSource.m" \
    "$HERE/SimCamSwizzles.m"

echo "Built: $DYLIB"
file "$DYLIB"
