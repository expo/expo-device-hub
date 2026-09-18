#!/usr/bin/env bash
set -euo pipefail
package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$package_root"
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: bash scripts/rebuild-from-source.sh"
  echo "Uses sources/{ffmpeg,nv-codec-headers,frida}, with POC_* source path overrides."
  echo "Prepare sources and NVRTC first; see docs/rebuilding-from-source.md."
  exit 0
fi
[[ $# -eq 0 ]] || { echo "Unexpected arguments; use environment variables to select sources" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo "Rebuild requires Linux x86-64; use bash scripts/source-container.sh rebuild" >&2; exit 1;
}
export POC_FFMPEG_SOURCE_DIR="${POC_FFMPEG_SOURCE_DIR:-sources/ffmpeg}"
export POC_NV_CODEC_HEADERS_SOURCE_DIR="${POC_NV_CODEC_HEADERS_SOURCE_DIR:-sources/nv-codec-headers}"
export POC_FRIDA_SOURCE_DIR="${POC_FRIDA_SOURCE_DIR:-sources/frida}"
export POC_FRIDA_DEVKIT_OUTPUT_DIR="${POC_FRIDA_DEVKIT_OUTPUT_DIR:-build/frida-devkits}"
export POC_OFFLINE=1
export POC_SOURCE_BUILD=1
# Frida validates a reusable devkit receipt or compiles a fresh source-only kit.
python3 scripts/frida-source.py build
export POC_FRIDA_GUM_DEVKIT_DIR="$POC_FRIDA_DEVKIT_OUTPUT_DIR/gum"
export POC_FRIDA_CORE_DEVKIT_DIR="$POC_FRIDA_DEVKIT_OUTPUT_DIR/core"
bun run build
bun run test:native
output_directory="${POC_DIST_DIR:-dist/linux-x64}"
"$output_directory/inject" --help
echo "Source rebuild complete. GPU capture was not exercised."
