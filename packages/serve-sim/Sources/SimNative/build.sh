#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. The JS bindings are written in Swift with
# node-swift (see ../../Package.swift and sim-module.swift).
#
# We opt into the new `swiftbuild` build system for reliable macro builds.
#
# napi_* stay undefined and resolve against the host (Node/Bun) at dlopen via
# `-undefined dynamic_lookup`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"          # packages/serve-sim (Package.swift root)
OUT_DIR="${1:-$PKG/dist/native}"
BUILD_DIR="$PKG/.build"
PRODUCT="serve-sim-native"
WEBRTC_FRAMEWORK_NAME="LiveKitWebRTC.framework"
mkdir -p "$OUT_DIR"
WEBRTC_RUNTIME_DIR="$(cd "$OUT_DIR/.." && pwd)/bin"
WEBRTC_RUNTIME_FRAMEWORK="$WEBRTC_RUNTIME_DIR/$WEBRTC_FRAMEWORK_NAME"

require_arm64() {
  local binary="$1"
  if ! lipo "$binary" -verify_arch arm64 >/dev/null; then
    echo "Expected arm64 Mach-O binary: $binary" >&2
    exit 1
  fi
}

require_arm64_only() {
  local binary="$1"
  local archs
  archs="$(lipo -archs "$binary")"
  if [ "$archs" != "arm64" ]; then
    echo "Expected arm64-only Mach-O binary, found '$archs': $binary" >&2
    exit 1
  fi
}

if [ ! -d "$PKG/node_modules/node-swift" ]; then
  echo "node-swift not found at $PKG/node_modules/node-swift (run: bun install)" >&2
  exit 1
fi

build_flags=(
  -c release
  --product "$PRODUCT"
  --package-path "$PKG"
  --build-path "$BUILD_DIR"
  --build-system swiftbuild
  --arch arm64
)
swift build "${build_flags[@]}" >&2
DYLIB="$(swift build --show-bin-path "${build_flags[@]}")/lib${PRODUCT}.dylib"
if [ ! -f "$DYLIB" ]; then
  echo "Expected build product not found at $DYLIB" >&2
  exit 1
fi

WEBRTC_ARTIFACT_FRAMEWORK="$(find "$BUILD_DIR/artifacts" -path "*/macos-*/$WEBRTC_FRAMEWORK_NAME" -type d -print -quit)"
if [ -z "$WEBRTC_ARTIFACT_FRAMEWORK" ]; then
  echo "Expected macOS LiveKitWebRTC framework artifact not found under $BUILD_DIR/artifacts" >&2
  exit 1
fi
WEBRTC_ARTIFACT_BINARY="$WEBRTC_ARTIFACT_FRAMEWORK/Versions/A/LiveKitWebRTC"
require_arm64 "$WEBRTC_ARTIFACT_BINARY"
WEBRTC_LICENSE="$(find "$BUILD_DIR/artifacts" -path "*/LiveKitWebRTC.xcframework/LICENSE" -type f -print -quit)"
WEBRTC_PRIVACY="$(find "$WEBRTC_ARTIFACT_FRAMEWORK" -name "PrivacyInfo.xcprivacy" -type f -print -quit)"

rm -rf "$WEBRTC_RUNTIME_FRAMEWORK"
mkdir -p "$WEBRTC_RUNTIME_DIR"
cp -a "$WEBRTC_ARTIFACT_FRAMEWORK" "$WEBRTC_RUNTIME_FRAMEWORK"
WEBRTC_RUNTIME_BINARY="$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/LiveKitWebRTC"
if [ "$(lipo -archs "$WEBRTC_RUNTIME_BINARY")" != "arm64" ]; then
  lipo "$WEBRTC_RUNTIME_BINARY" -thin arm64 -output "$WEBRTC_RUNTIME_BINARY.arm64"
  mv "$WEBRTC_RUNTIME_BINARY.arm64" "$WEBRTC_RUNTIME_BINARY"
fi
require_arm64_only "$WEBRTC_RUNTIME_BINARY"
if [ -z "$WEBRTC_LICENSE" ]; then
  echo "Expected WebRTC license not found under $BUILD_DIR/artifacts" >&2
  exit 1
fi
if [ -z "$WEBRTC_PRIVACY" ]; then
  echo "Expected WebRTC privacy manifest not found in $WEBRTC_ARTIFACT_FRAMEWORK" >&2
  exit 1
fi
cp "$WEBRTC_LICENSE" "$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/Resources/LICENSE.webrtc"
# The upstream binary artifact currently nests PrivacyInfo.xcprivacy under a
# second Versions/A directory. Put it in the framework Resources directory so
# packaging tools and macOS discover it, then remove the malformed duplicate.
cp "$WEBRTC_PRIVACY" "$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/Resources/PrivacyInfo.xcprivacy"
rm -rf "$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/Versions"
# Headers and Clang modules are build-time inputs. The npm package only loads
# this framework dynamically, so omit them from the runtime artifact.
rm -rf "$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/Headers" "$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/Modules"
# npm omits framework symlinks from tarballs. Flatten the runtime framework so
# the installed package remains a complete, signable bundle without them.
rm -f \
  "$WEBRTC_RUNTIME_FRAMEWORK/LiveKitWebRTC" \
  "$WEBRTC_RUNTIME_FRAMEWORK/Resources" \
  "$WEBRTC_RUNTIME_FRAMEWORK/Headers" \
  "$WEBRTC_RUNTIME_FRAMEWORK/Modules"
mv "$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/LiveKitWebRTC" "$WEBRTC_RUNTIME_FRAMEWORK/LiveKitWebRTC"
mv "$WEBRTC_RUNTIME_FRAMEWORK/Versions/A/Resources" "$WEBRTC_RUNTIME_FRAMEWORK/Resources"
rm -rf "$WEBRTC_RUNTIME_FRAMEWORK/Versions"
codesign -s - -f --deep "$WEBRTC_RUNTIME_FRAMEWORK"
codesign --verify --deep --strict "$WEBRTC_RUNTIME_FRAMEWORK"
require_arm64_only "$WEBRTC_RUNTIME_FRAMEWORK/LiveKitWebRTC"

OUT="$OUT_DIR/${PRODUCT}.node"
cp -a "$DYLIB" "$OUT"
strip -x "$OUT"
install_name_tool \
  -change "@rpath/LiveKitWebRTC.framework/LiveKitWebRTC" \
  "@loader_path/../bin/LiveKitWebRTC.framework/LiveKitWebRTC" \
  "$OUT"
codesign -s - -f "$OUT"
codesign --verify --strict "$OUT"
require_arm64_only "$OUT"

echo "Built: $OUT"
file "$OUT"
