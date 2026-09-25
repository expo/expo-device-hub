#!/usr/bin/env bash
# The isolated run: `bun run test`.
#
# Two things keep it inside the repo. A private state directory, so no test
# finds another session's server or leaves files in $TMPDIR/serve-sim. And an
# xcrun shim first on PATH that refuses simctl, so no test touches a booted
# simulator. Simulator-backed suites therefore skip deterministically.
#
# Pass test paths to narrow the run; with none it runs the whole Bun suite.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/serve-sim-test.XXXXXX")"
trap 'rm -rf "$STATE_DIR"' EXIT
export SERVE_SIM_STATE_DIR="$STATE_DIR"
export PATH="$HERE/shims:$PATH"
# Values left exported from an e2e run must not turn skips into failures here.
unset SERVE_SIM_E2E_REQUIRED SERVE_SIM_TEST_UDID

cd "$ROOT"
if [ $# -eq 0 ]; then
  set -- packages/serve-sim/src/__tests__/ packages/serve-sim/scripts/tart/__tests__/
fi
bun test --max-concurrency=1 "$@"
