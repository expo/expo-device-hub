#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:?Pass an output directory}"
mkdir -p "$OUT_DIR"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libServeSimEgressGuard.dylib"
xcrun --sdk iphonesimulator clang -std=c11 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow \
  -arch arm64 -arch x86_64 -mios-simulator-version-min=15.0 -isysroot "$SDK" \
  -dynamiclib -install_name '@rpath/libServeSimEgressGuard.dylib' \
  -Wl,-U,_serve_sim_startup_all_processes \
  "$HERE/egress-guard.c" "$HERE/policy.c" -o "$DYLIB"
# The resident guard, like its loader, may link only libSystem.
xcrun --sdk iphonesimulator clang -std=c11 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow \
  -arch arm64 -arch x86_64 -mios-simulator-version-min=15.0 -isysroot "$SDK" \
  "$HERE/check.c" -o "$OUT_DIR/serve-sim-egress-check"
otool -L "$DYLIB" | awk '/^\t/ {print $1}' | while read -r linked; do
  case "$linked" in
    '@rpath/libServeSimEgressGuard.dylib'|'/usr/lib/libSystem.B.dylib') ;;
    *) echo "Egress guard links unexpected library: $linked" >&2; exit 1 ;;
  esac
done
xcrun --sdk macosx clang -std=c11 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow \
  -arch arm64 -arch x86_64 "$HERE/control.c" "$HERE/policy.c" \
  -o "$OUT_DIR/serve-sim-egress-control"
xcrun --sdk macosx clang -std=c11 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow \
  -arch arm64 -arch x86_64 "$HERE/boot-identity.c" -lproc \
  -o "$OUT_DIR/serve-sim-egress-boot-identity"
