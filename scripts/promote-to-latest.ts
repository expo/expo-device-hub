#!/usr/bin/env bun

import { $ } from "bun";
import { readReleaseManifest } from "./lib/release-manifest.ts";

// Node 24 bundles an older npm. OIDC dist-tag writes require npm 11.21+.
for (const spec of await readReleaseManifest(process.argv[2])) {
  await $`npx --yes npm@11.21.0 dist-tag add ${spec} latest`;
}
