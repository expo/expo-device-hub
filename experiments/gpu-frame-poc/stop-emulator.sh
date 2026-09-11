#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
pid=$(cat emulator.pid)
if [[ -r /proc/$pid/cmdline ]]; then
  args=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  if [[ $args != *qemu-system* || $args != *'-avd gpu_poc '* ]]; then
    echo "PID $pid does not identify our gpu_poc emulator; refusing to stop it." >&2
    exit 1
  fi
  kill "$pid"
  for ((i=0;i<45;i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo 'Emulator has not exited; leaving its lock files intact.' >&2
    exit 1
  fi
fi
# This script operates only on the experiment's dedicated AVD.
rm -f "$HOME/.android/avd/gpu_poc.avd/hardware-qemu.ini.lock" \
      "$HOME/.android/avd/gpu_poc.avd/snapshot.lock.lock"
