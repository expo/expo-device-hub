#!/bin/bash
# Create two API-36 AVDs with the same device profile for the two renderer modes.
# medium_phone uses the 720x1600, 4GB setup that EAS device sessions use.
set -euo pipefail
PROFILE=$1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "::: Tools"
for t in g++ python3 node bun ffmpeg; do printf "%s: %s\n" "$t" "$(command -v "$t" || echo missing)"; done
grep Revision "$ANDROID_HOME/emulator/source.properties"
echo "DISPLAY=${DISPLAY:-unset} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset}"
REPO=https://dl.google.com/android/repository
TOOLS=$(curl -fsSL "$REPO/repository2-3.xml" | grep -oE 'commandlinetools-linux-[0-9]+_latest\.zip' \
  | sort -u -t- -k3,3n | tail -1)
REV=$(echo "$TOOLS" | grep -oE '[0-9]+')
echo "$TOOLS"
curl -fsSL -o /tmp/tools.zip "$REPO/$TOOLS"
rm -rf /tmp/tools && unzip -q /tmp/tools.zip -d /tmp/tools
rm -rf "$ANDROID_HOME/cmdline-tools/$REV" && mv /tmp/tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/$REV"
AVDM="$ANDROID_HOME/cmdline-tools/$REV/bin/avdmanager"

IMAGE="system-images;android-36;google_apis;x86_64"
ls -d "$ANDROID_HOME/system-images/android-36/google_apis/x86_64" || exit 1
for config in base basess; do
  avd="${PROFILE}_$config"
  echo no | "$AVDM" create avd --name "$avd" --package "$IMAGE" --force --device "$PROFILE" \
    > "/tmp/avd-$avd.log" 2>&1 || { cat "/tmp/avd-$avd.log"; exit 1; }
  if [ "$PROFILE" = medium_phone ]; then
    python3 -I - "$HOME/.android/avd/$avd.avd/config.ini" <<'EOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
text += "\nhw.ramSize=4096\n"
text += "\nhw.lcd.height=1600\nhw.lcd.width=720\nhw.lcd.density=300\n"
heap = re.search(r"vm.heapSize=(\d\w+)", text)
if not heap:
    text += "\nvm.heapSize=768\n"
elif "g" in heap.group(1).lower():
    pass
elif int(re.match(r"\d+", heap.group(1)).group(0)) < 768:
    text += "\nvm.heapSize=768\n"
open(path, "w").write(text)
EOF
  fi
done
for config in base basess; do
  avd="${PROFILE}_$config"
  echo "$avd config.ini: $(grep -E '^(hw\.device\.name|hw\.lcd\.(width|height|density)|hw\.ramSize|vm\.heapSize|hw\.cpu\.ncore|hw\.gpu\.mode|hw\.gpu\.enabled|hw\.audio[A-Za-z]+|hw\.camera\.[a-z]+|hw\.dPad|hw\.keyboard|fastboot\.[A-Za-z]+)=' \
    "$HOME/.android/avd/$avd.avd/config.ini" | sort | tr '\n' ' ')"
  mkdir -p "$ROOT/out/avd"
  cp "$HOME/.android/avd/$avd.avd/config.ini" "$ROOT/out/avd/$avd.config.ini"
  [ -f "$HOME/.android/avd/$avd.avd/config.ini.bak" ] && cp "$HOME/.android/avd/$avd.avd/config.ini.bak" "$ROOT/out/avd/$avd.config.ini.bak"
done
emulator -list-avds
{
  echo "export ANDROID_HOME=$ANDROID_HOME"
  echo "export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:\$PATH"
} > "$HOME/android-env.sh"
