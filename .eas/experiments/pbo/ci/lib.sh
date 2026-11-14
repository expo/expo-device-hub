#!/bin/bash
# Shared EAS readback-benchmark helpers. Set ROOT, then source this file.
[ -f "$HOME/android-env.sh" ] && source "$HOME/android-env.sh"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
CAP=${EXPO_PBO_CAPTURE:-"$ROOT/capture"}
LOGS="$ROOT/logs"
OUT="$ROOT/out"
mkdir -p "$LOGS" "$OUT"
SERIAL=emulator-5554
ADB="adb -s $SERIAL"
SOCK="$(node "$CAP/src/cli.mjs" socket-path --port 5554)"
WS=/tmp/ws
PAGE=http://10.0.2.2:3401/frame-counter.html

now_ms() { python3 -I -c 'import time; print(int(time.time() * 1000))'; }
qemu_pid() { pgrep -f qemu-system | head -1; }

install_ws() {
  [ -d "$WS/node_modules/ws" ] && return 0
  mkdir -p "$WS" && (cd "$WS" && npm init -y > /dev/null && npm install --no-fund --no-audit ws@8.18.0) \
    > "$LOGS/ws-install.log" 2>&1 || { tail -20 "$LOGS/ws-install.log"; return 1; }
}

start_http() {
  python3 -m http.server 3401 --bind 127.0.0.1 --directory "$ROOT/fixtures" > "$LOGS/http.log" 2>&1 &
  HTTP_PID=$!
}

qemu_facts() {
  local pid
  pid=$(qemu_pid)
  [ -n "$pid" ] || { echo "no qemu process"; return; }
  echo "qemu $pid args: $(tr '\0' ' ' < "/proc/$pid/cmdline" | cut -d' ' -f2- | cut -c1-600)"
  echo "qemu env: $(tr '\0' '\n' < "/proc/$pid/environ" | grep -E '^(LD_PRELOAD|EXPO_EMULATOR_CAPTURE_[A-Z]+|DISPLAY|WAYLAND_DISPLAY)=' | tr '\n' ' ')"
  echo "agent in qemu: $(grep -m1 -oE '/[^ ]*libexpo_emulator_capture[^ ]*' "/proc/$pid/maps" || echo none)"
  echo "x264 in qemu: $(grep -m1 -oE '/[^ ]*libx264[^ ]*' "/proc/$pid/maps" || echo none)"
}

# wait_boot <t0 ms> <out json>: polls sys.boot_completed once a second; writes the boot time.
wait_boot() {
  local t0=$1 out=$2 start=$SECONDS t1
  while [ $((SECONDS - start)) -lt 600 ]; do
    if [ "$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      t1=$(now_ms)
      echo "{\"launchMs\": $t0, \"bootCompletedMs\": $t1, \"bootS\": $(python3 -I -c "print(round(($t1 - $t0) / 1000, 1))")}" > "$out"
      echo "booted in $(python3 -I -c "print(round(($t1 - $t0) / 1000, 1))") s (sys.boot_completed, polled every 1 s)"
      return 0
    fi
    sleep 1
  done
  echo "boot timed out after 600 s"
  return 1
}

wait_socket() {
  for _ in $(seq 1 90); do [ -S "$SOCK" ] && { echo "socket $SOCK"; return 0; }; sleep 1; done
  echo "no socket at $SOCK"
  return 1
}

# launch_emulator <avd> <log label> <emulator args...>: the package CLI preloads the agent
# (LD_PRELOAD) on port 5554. The caller passes the -gpu flag and any avdslim flags.
launch_emulator() {
  local avd=$1 label=$2
  shift 2
  rm -f "$SOCK" "$SOCK.read" "$SOCK.probe" "$SOCK.pixels"
  echo "emulator args: -avd $avd -no-window -no-audio -no-boot-anim -no-snapshot-save -no-metrics -port 5554 $*" | tee "$LOGS/args-$label.txt"
  node "$CAP/src/cli.mjs" launch --log "$LOGS/agent-$label.log" -- -avd "$avd" -no-window -no-audio \
    -no-boot-anim -no-snapshot-save -no-metrics -port 5554 "$@" > "$LOGS/emulator-$label.log" 2>&1 &
  LAUNCHER=$!
}

stop_emulator() {
  $ADB emu kill > /dev/null 2>&1 || true
  for _ in $(seq 1 40); do pgrep -f qemu-system > /dev/null || break; sleep 1; done
  pkill -9 -f qemu-system > /dev/null 2>&1 || true
  sleep 3
}

# prepare_chrome <url>: Chrome without first-run screens, its DevTools socket on tcp:9223.
prepare_chrome() {
  $ADB shell svc power stayon true
  $ADB shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-search-engine-choice-screen" > /data/local/tmp/chrome-command-line'
  $ADB shell am set-debug-app --persistent com.android.chrome > /dev/null 2>&1
  $ADB shell pm grant com.android.chrome android.permission.POST_NOTIFICATIONS > /dev/null 2>&1
}

open_page() {
  $ADB shell am start -a android.intent.action.VIEW -d "$1" com.android.chrome > /dev/null
  sleep 15
  echo "focus: $($ADB shell dumpsys window | grep -m1 -oE 'mCurrentFocus=[^}]+')"
}

# device_facts <avd>: the AVD files, the guest's view and what avdslim changed.
device_facts() {
  local avd_dir="$HOME/.android/avd/$1.avd"
  echo "config.ini: $(grep -E '^(hw\.device\.name|hw\.lcd\.(width|height|density)|hw\.ramSize|vm\.heapSize|hw\.cpu\.ncore|hw\.gpu\.mode|hw\.audio[A-Za-z]+|hw\.camera\.[a-z]+|hw\.dPad|hw\.keyboard|fastboot\.[A-Za-z]+)=' "$avd_dir/config.ini" | tr '\n' ' ')"
  echo "hardware-qemu.ini: $(grep -E '^(hw\.lcd\.(width|height|density)|hw\.ramSize|vm\.heapSize|hw\.gpu\.mode|hw\.cpu\.ncore|hw\.cpu\.arch)' "$avd_dir/hardware-qemu.ini" | tr '\n' ' ')"
  echo "wm size: $($ADB shell wm size | tr -d '\r' | tr '\n' ' '); wm density: $($ADB shell wm density | tr -d '\r' | tr '\n' ' ')"
  echo "guest: dalvik.vm.heapsize=$($ADB shell getprop dalvik.vm.heapsize | tr -d '\r'); ro.config.low_ram=$($ADB shell getprop ro.config.low_ram | tr -d '\r'); cpus $($ADB shell nproc | tr -d '\r'); $($ADB shell grep MemTotal /proc/meminfo | tr -d '\r')"
  echo "guest settings: background_process_limit=$($ADB shell settings get global background_process_limit | tr -d '\r') activity_manager_constants=$($ADB shell settings get global activity_manager_constants | tr -d '\r') auto_sync=$($ADB shell settings get global auto_sync | tr -d '\r') animator_duration_scale=$($ADB shell settings get global animator_duration_scale | tr -d '\r') disabled packages=$($ADB shell pm list packages -d | wc -l | tr -d ' \r')"
  echo "renderer: $(grep -oE "vulkan_mode_selected:[a-z_]+ gles_mode_selected:[a-z_]+" "$LOGS/emulator-$2.log" | head -1); $(grep -E "Graphics Adapter|Selecting Vulkan device|GPU emulation" "$LOGS/emulator-$2.log" | head -3 | tr '\n' ' ' | cut -c1-400)"
}

# mem_snap <out> [full]: QEMU host memory (/proc status and smaps_rollup), the VM's memory and
# the guest's /proc/meminfo; with "full" also the guest's dumpsys meminfo summary.
mem_snap() {
  local out=$1 pid
  pid=$(qemu_pid)
  {
    echo "time $(now_ms)"
    [ -n "$pid" ] && grep -E '^(VmRSS|VmHWM|VmSwap|RssAnon|RssFile|RssShmem|Threads):' "/proc/$pid/status" | sed 's/^/qemu_status /'
    [ -n "$pid" ] && grep -E '^(Rss|Pss|Pss_Anon|Pss_File|Pss_Shmem|Swap|SwapPss):' "/proc/$pid/smaps_rollup" | sed 's/^/qemu_rollup /'
    grep -E '^(MemTotal|MemFree|MemAvailable|Cached|SwapTotal|SwapFree):' /proc/meminfo | sed 's/^/host /'
    $ADB shell cat /proc/meminfo 2> /dev/null | tr -d '\r' | grep -E '^(MemTotal|MemFree|MemAvailable|Cached|SwapTotal|SwapFree):' | sed 's/^/guest /'
    if [ "${2:-}" = full ]; then
      $ADB shell dumpsys meminfo 2> /dev/null | tr -d '\r' | grep -E '^ *(Total RAM|Free RAM|Used RAM|Lost RAM|ZRAM):' | sed 's/^ */dumpsys /'
    fi
  } > "$out"
}
