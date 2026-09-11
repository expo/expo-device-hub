#!/usr/bin/env bash
# Fresh Pixel 9 profile: preserve every generated setting except display VSync.
set -euo pipefail
sdk=${ANDROID_HOME:?Set ANDROID_HOME to the prepared SDK directory}
avd=${POC_AVD:-pixel9_gpu_live}
[[ $avd =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid experiment AVD name' >&2; exit 1; }
if ! grep -q 'Pkg.Revision=36.6.11' "$sdk/emulator/source.properties"; then
  echo 'This proof requires emulator 36.6.11 (build 15507667).' >&2
  exit 1
fi
if [[ -e "$HOME/.android/avd/$avd.ini" || -e "$HOME/.android/avd/$avd.avd" ]]; then
  echo "$avd already exists; choose a fresh POC_AVD name." >&2
  exit 1
fi
printf 'no\n' | "$sdk/cmdline-tools/latest/bin/avdmanager" create avd \
  --name "$avd" --package 'system-images;android-36;google_apis;x86_64' --device pixel_9
python3 - "$HOME/.android/avd/$avd.avd/config.ini" <<'PY'
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
original = p.read_text()
updated, count = re.subn(r'^hw\.lcd\.vsync=.*$', 'hw.lcd.vsync=120', original, flags=re.MULTILINE)
if not count:
    updated = original.rstrip('\n') + '\nhw.lcd.vsync=120\n'
def settings(text):
    return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
before, after = settings(original), settings(updated)
changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
assert changed <= {'hw.lcd.vsync'}, changed
assert after['hw.lcd.vsync'] == '120'
p.write_text(updated)
print({key: after.get(key) for key in ('hw.device.name', 'hw.lcd.width', 'hw.lcd.height', 'hw.lcd.density', 'hw.lcd.vsync')})
PY
