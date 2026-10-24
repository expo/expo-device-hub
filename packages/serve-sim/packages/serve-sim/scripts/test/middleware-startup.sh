#!/usr/bin/env bash
set -euo pipefail

# Package scripts run from this workspace, regardless of its monorepo location.
# The probe build goes to its own folder, so it never replaces the real dist/
# build; it stays inside the package so that `ws` resolves.
probe_build="$(mktemp -d .middleware-startup.XXXXXX)"
probe_state="$(mktemp -d)"
trap 'rm -rf "$probe_build" "$probe_state"' EXIT
bun build src/middleware.ts --target node --format esm --external ws --outdir "$probe_build"
PROBE_BUILD="$probe_build" SERVE_SIM_STATE_DIR="$probe_state" timeout --kill-after=5s 15s node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const { simMiddleware } = await import(`./${process.env.PROBE_BUILD}/middleware.js`);
const middleware = simMiddleware({
  basePath: '/_expo/plugins/expo-device-hub/vendor/serve-sim',
  proxyHelpers: true,
});
assert.equal(typeof middleware, 'function');
assert.equal(typeof middleware.handleUpgrade, 'function');
assert.equal(typeof middleware.handleWebSocket, 'function');
console.log('serve-sim middleware initializes on Node');
NODE
