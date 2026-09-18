#!/usr/bin/env bash
# Run the same source commands in Linux amd64; no GPU is needed for rebuilding.
set -euo pipefail
package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_name="${POC_SOURCE_IMAGE:-expo-emulator-capture-source:local}"
if [[ "${1:-}" == "--help" || $# -eq 0 ]]; then
  cat <<'HELP'
Usage: bash scripts/source-container.sh fetch|create|verify|check-release [arguments]
       bash scripts/source-container.sh rebuild [arguments]
       bash scripts/source-container.sh run COMMAND [arguments]

Builds Dockerfile.source once (set POC_REBUILD_IMAGE=1 to rebuild it).
POC_* variables are forwarded. Absolute dependency/output directory overrides
are mounted at their original paths; package paths are mapped to /work.
Use relative output arguments inside the mounted package, not host-only paths.
HELP
  exit 0
fi
if [[ "${POC_REBUILD_IMAGE:-0}" == "1" ]] || ! docker image inspect "$image_name" >/dev/null 2>&1; then
  docker build --platform linux/amd64 -f "$package_root/Dockerfile.source" -t "$image_name" "$package_root"
fi
docker_arguments=(run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" --ulimit core=0
  --mount "type=bind,source=$package_root,target=/work" --workdir /work)
mounted_paths=()
add_mount() {
  local mount_path="$1" already_mounted=0 existing_mount
  for existing_mount in "${mounted_paths[@]+"${mounted_paths[@]}"}"; do
    [[ "$existing_mount" != "$mount_path" ]] || already_mounted=1
  done
  if [[ "$already_mounted" == 0 ]]; then
    docker_arguments+=(--mount "type=bind,source=$mount_path,target=$mount_path")
    mounted_paths+=("$mount_path")
  fi
}
if [[ "${POC_CONTAINER_OFFLINE:-0}" == 1 ]]; then
  docker_arguments+=(--network=none)
fi
# Bash 3-compatible; do not split paths on whitespace or evaluate env values.
while IFS='=' read -r key value; do
  [[ "$key" == POC_* ]] || continue
  case "$key" in
    POC_FRIDA_SOURCE_OVERRIDES)
      override_description="$(python3 "$package_root/scripts/container-source-paths.py" "$package_root" "$value")"
      value="${override_description%%$'\n'*}"
      if [[ "$override_description" == *$'\n'* ]]; then
        while IFS= read -r mount_path; do
          [[ -z "$mount_path" ]] || add_mount "$mount_path"
        done <<< "${override_description#*$'\n'}"
      fi
      ;;
    *_DIR|POC_NVRTC_LIBRARY)
      if [[ "$value" == "$package_root" || "$value" == "$package_root/"* ]]; then
        value="/work${value#"$package_root"}"
      elif [[ "$value" == /* ]]; then
        mount_path="$value"
        [[ "$key" != POC_NVRTC_LIBRARY ]] || mount_path="$(dirname "$value")"
        if [[ ! -d "$mount_path" ]]; then
          echo "External mount does not exist: $mount_path; create output directories before running Docker" >&2
          exit 1
        fi
        [[ "$mount_path" != *,* ]] || { echo "Docker bind paths cannot contain commas" >&2; exit 1; }
        add_mount "$mount_path"
      fi
      ;;
  esac
  docker_arguments+=(--env "$key=$value")
done < <(env)
case "$1" in
  rebuild) shift; command=(bash scripts/rebuild-from-source.sh "$@");;
  run) shift; command=("$@");;
  *) command=(python3 scripts/source-archive.py "$@");;
esac
[[ ${#command[@]} -gt 0 ]] || { echo "Missing command" >&2; exit 1; }
exec docker "${docker_arguments[@]}" "$image_name" "${command[@]}"
