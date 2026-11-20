#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCES="$(cd "$HERE/.." && pwd)"
OUT_DIR="${1:-$HERE/../../.build/physical-device-stream-spike}"
mkdir -p "$OUT_DIR/obj" "$OUT_DIR/shim"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
SHIM="$SOURCES/CoreDeviceShim"
TARGET=arm64-apple-macos14.0

cat > "$OUT_DIR/shim/module.modulemap" <<MAP
module CoreDeviceShim {
  umbrella "$SHIM/include"
  export *
}
MAP

for source in "$SHIM"/*.c "$SHIM"/*.m "$SHIM"/*.S; do
  clang -c -O2 -fobjc-arc -target "$TARGET" -I"$SHIM/include" "$source" -o "$OUT_DIR/obj/$(basename "$source").o"
done

swiftc -emit-library -static -module-name StreamingPolicy -emit-module \
  -emit-module-path "$OUT_DIR/StreamingPolicy.swiftmodule" -swift-version 5 -O -target "$TARGET" \
  "$SOURCES"/StreamingPolicy/*.swift -o "$OUT_DIR/libStreamingPolicy.a"

NATIVE=(
  CoreDeviceBridge CoreDeviceDisplayInfo CoreDeviceDisplayState CoreDeviceHingeReadback CoreDeviceState
  CoreDeviceStateReadback CoreDeviceMediaStreamCalls CoreDeviceMediaStreamSession HEVCRTPReceiver HEVCDecoder
)
FILES=()
for name in "${NATIVE[@]}"; do FILES+=("$SOURCES/SimNative/$name.swift"); done

swiftc -parse-as-library -swift-version 5 -O -target "$TARGET" -module-name PhysicalDeviceStreamSpike \
  -I "$OUT_DIR" -Xcc -fmodule-map-file="$OUT_DIR/shim/module.modulemap" \
  "${FILES[@]}" "$HERE/main.swift" "$OUT_DIR"/obj/*.o "$OUT_DIR/libStreamingPolicy.a" \
  -o "$OUT_DIR/physical-device-stream-spike"

echo "$OUT_DIR/physical-device-stream-spike"
