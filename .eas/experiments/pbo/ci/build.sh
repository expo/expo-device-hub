#!/bin/bash
# Build the experimental Linux agent with system x264 build 165.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAP=${EXPO_PBO_CAPTURE:-"$ROOT/capture"}
mkdir -p "$ROOT/logs"
echo "::: Host"
grep PRETTY_NAME /etc/os-release
echo "vcpus $(nproc); $(grep -m1 'model name' /proc/cpuinfo); $(grep MemTotal /proc/meminfo)"
lscpu | grep -E "^(Model name|Socket|Core|Thread|CPU\(s\)|Hypervisor)" | sed 's/^/  /'
echo "$(g++ --version | head -1); node $(node --version); bun $(bun --version)"
if [ ! -f /usr/include/x264.h ]; then
  echo "::: Install the x264 build 165 header (libx264-dev)"
  sudo apt-get update -qq > /dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libx264-dev > /dev/null
fi
grep -m1 "define X264_BUILD" /usr/include/x264.h
cd "$CAP"
export CXX=g++
bun run build:linux-x64 > "$ROOT/logs/build.log" 2>&1
STATUS=$?
tail -5 "$ROOT/logs/build.log"
echo "build exit $STATUS; warning lines: $(grep -ci 'warning' "$ROOT/logs/build.log")"
[ "$STATUS" = 0 ] || { cat "$ROOT/logs/build.log"; exit 1; }
ls -la dist/linux-x64/libexpo_emulator_capture.so
