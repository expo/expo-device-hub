#!/usr/bin/env bash
set -euo pipefail
: "${SERVE_EMU_EXPERIMENTAL_GPU_SOCKET:?Set the native capture socket path}"
export SERVE_EMU_EXPERIMENTAL_GPU_SERIAL=${SERVE_EMU_EXPERIMENTAL_GPU_SERIAL:-emulator-5554}
hub_dir=${HUB_DIR:-/home/expo/device-hub-live}
exec bun "$hub_dir/node_modules/expo-device-hub/dist/server/cli.mjs" \
  --platform android --host 127.0.0.1 --port 3400 \
  --transport "${POC_TRANSPORT:-h264}" --stream-source scrcpy --video-fps "${POC_STREAM_FPS:-${POC_VSYNC:-60}}" \
  --video-bitrate 12000000 --max-dimension "${POC_MAX_DIMENSION:-0}"
