#!/usr/bin/env bash
# Requires ANDROID_HOME with command-line tools installed, and accepted SDK licenses.
set -euo pipefail
sdk=${ANDROID_HOME:?Set ANDROID_HOME to the SDK directory}
"$sdk/cmdline-tools/latest/bin/sdkmanager" \
  'platform-tools' 'emulator' 'system-images;android-36;google_apis;x86_64' \
  'platforms;android-35' 'build-tools;36.0.0'
# capture.cpp requires the ABI from emulator 36.6.11; newer SDK packages may differ.
if ! grep -q 'Pkg.Revision=36.6.11' "$sdk/emulator/source.properties"; then
  echo 'This proof requires emulator 36.6.11 (build 15507667).' >&2
  exit 1
fi
if [[ -e "$HOME/.android/avd/gpu_poc.ini" ]]; then
  echo 'gpu_poc already exists; leaving it intact.'
  exit 0
fi
printf 'no\n' | "$sdk/cmdline-tools/latest/bin/avdmanager" create avd \
  --name gpu_poc --package 'system-images;android-36;google_apis;x86_64' --device pixel_9
python3 - <<'PY'
from pathlib import Path
p=Path.home()/'.android/avd/gpu_poc.avd/config.ini'
settings=dict(line.split('=',1) for line in p.read_text().splitlines() if '=' in line)
settings={k.strip():v.strip() for k,v in settings.items()}
settings.update({'hw.lcd.width':'720','hw.lcd.height':'1280','hw.lcd.density':'240',
                 'hw.ramSize':'4096','hw.cpu.ncore':'4','hw.gpu.enabled':'yes',
                 'hw.gpu.mode':'host','disk.dataPartition.size':'6442450944'})
p.write_text(''.join(f'{k}={v}\n' for k,v in settings.items()))
PY
