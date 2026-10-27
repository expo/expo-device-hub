#!/usr/bin/env bash
set -euo pipefail

# Package scripts run from this workspace, regardless of its monorepo location.
# The probe build goes to its own folder, so it never replaces the real dist/
# build; it stays inside the package so that `ws` resolves.
probe_build="$(mktemp -d .middleware-startup.XXXXXX)"
probe_state="$(mktemp -d)"
trap 'rm -rf "$probe_build" "$probe_state"' EXIT
bun build src/middleware.ts --target node --format esm --external ws --define '__SERVE_SIM_COMPILED__=false' --outdir "$probe_build"
SERVE_SIM_STATE_DIR="$probe_state" timeout --kill-after=5s 15s node scripts/test/middleware-startup.mjs "$probe_build/middleware.js"
