#!/usr/bin/env bash
# Run after building serve-emu in this checkout. Reuses the published Hub UI.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
source_dir="$root/packages/serve-emu/packages/serve-emu"
hub_dir=${HUB_DIR:-/home/expo/device-hub-live}
test -f "$source_dir/dist/gpu-session.js"
mkdir -p "$hub_dir"
cd "$hub_dir"
test -f package.json || bun init -y >/dev/null
bun add expo-device-hub@0.10.1
bun pm trust node-datachannel
vendor="$hub_dir/node_modules/expo-device-hub/vendor/serve-emu"
# Only the disposable installation is patched; published packages are untouched.
cp -R "$source_dir/dist/." "$vendor/dist/"
cp -R "$source_dir/vendor/." "$vendor/vendor/"
echo "Installed experimental serve-emu into $hub_dir"
