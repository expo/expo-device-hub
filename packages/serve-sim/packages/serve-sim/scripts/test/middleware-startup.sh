#!/usr/bin/env bash
set -euo pipefail

# Package scripts run from this workspace, regardless of its monorepo location.
bun build src/middleware.ts --target node --format esm --external ws --outdir dist
probe_state="$(mktemp -d)"
trap 'rm -rf "$probe_state"' EXIT
SERVE_SIM_STATE_DIR="$probe_state" timeout --kill-after=5s 15s node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { simMiddleware } from './dist/middleware.js';
const middleware = simMiddleware({
  basePath: '/_expo/plugins/expo-device-hub/vendor/serve-sim',
  proxyHelpers: true,
});
assert.equal(typeof middleware, 'function');
assert.equal(typeof middleware.handleUpgrade, 'function');
assert.equal(typeof middleware.handleWebSocket, 'function');
console.log('serve-sim middleware initializes on Node');
NODE
