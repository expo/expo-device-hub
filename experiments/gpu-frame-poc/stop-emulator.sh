#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
avd=${POC_AVD:-gpu_poc}
[[ $avd =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid experiment AVD name' >&2; exit 1; }
pid=$(cat emulator.pid)
if [[ -r /proc/$pid/cmdline ]]; then
  args=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  if [[ $args != *qemu-system* || $args != *"-avd $avd "* ]]; then
    echo "PID $pid does not identify our $avd emulator; refusing to stop it." >&2
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
rm -f "$HOME/.android/avd/$avd.avd/hardware-qemu.ini.lock" \
      "$HOME/.android/avd/$avd.avd/snapshot.lock.lock"
