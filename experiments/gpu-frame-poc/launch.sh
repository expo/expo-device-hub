#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export DISPLAY=${DISPLAY:-:99}
nohup "$ANDROID_HOME/emulator/emulator" -avd gpu_poc \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu host -feature -Vulkan -accel on -cores 4 -memory 4096 \
  -vsync-rate "${POC_VSYNC:-60}" -port 5554 \
  > emulator.log 2>&1 < /dev/null &
echo $! > emulator.pid
echo "Emulator PID: $(cat emulator.pid)"
