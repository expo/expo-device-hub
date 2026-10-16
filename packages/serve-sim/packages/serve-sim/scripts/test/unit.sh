#!/usr/bin/env bash
# The isolated run: `bun run test`.
#
# Three things keep it inside the repo. A private state directory, so no test
# finds another session's server or leaves files in $TMPDIR/serve-sim. A private
# TMPDIR, so upload and screenshot staging tests never fill, prune or delete the
# staging folders of serve-sim servers running on this Mac. And an xcrun shim
# first on PATH that refuses simctl, so no test touches a booted simulator.
# Simulator-backed suites therefore skip deterministically.
#
# Pass test paths to narrow the run; with none it runs the whole Bun suite.
# Flags alone (as --flag=value, for example --shard=1/2) keep the whole suite.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/serve-sim-test.XXXXXX")"
trap 'rm -rf "$STATE_DIR"' EXIT
export SERVE_SIM_STATE_DIR="$STATE_DIR"
mkdir "$STATE_DIR/tmp"
export TMPDIR="$STATE_DIR/tmp"
# The capture CA normally lives in the user's Application Support folder; tests keep their own.
export SERVE_SIM_CAPTURE_CA_DIR="$STATE_DIR/capture-ca"
export PATH="$HERE/shims:$PATH"
# Values left exported from an e2e run must not turn skips into failures here.
unset SERVE_SIM_E2E_REQUIRED SERVE_SIM_TEST_UDID SERVE_SIM_DUO_E2E_DEVICE SERVE_SIM_DUO_REBOOT_E2E

cd "$ROOT"
paths=false
for arg in "$@"; do case "$arg" in -*) ;; *) paths=true ;; esac; done
if [ "$paths" = false ]; then
  set -- "$@" packages/serve-sim/src/ packages/serve-sim/scripts/tart/__tests__/
fi
bun test --max-concurrency=1 "$@"
