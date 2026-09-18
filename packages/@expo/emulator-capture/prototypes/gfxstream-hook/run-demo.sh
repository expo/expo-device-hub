#!/usr/bin/env bash
set -euo pipefail
demo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd -- "$demo_dir/../.." && pwd)"

if [[ "${1:-}" == --docker ]]; then
  shift
  docker build -t expo-gfxstream-hook-demo:local -f "$demo_dir/Dockerfile" "$demo_dir"
  # SYS_PTRACE applies only to this disposable container. Keep default seccomp.
  exec docker run --rm --cap-add=SYS_PTRACE \
    --mount "type=bind,src=$package_dir,dst=/project" \
    -e "DEMO_JOBS=${DEMO_JOBS:-2}" \
    expo-gfxstream-hook-demo:local \
    python3 prototypes/gfxstream-hook/run-demo.py "$@"
fi

exec python3 "$demo_dir/run-demo.py" "$@"
