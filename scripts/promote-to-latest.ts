#!/usr/bin/env bun

import { $ } from "bun";
import { readReleaseManifest } from "./lib/release-manifest.ts";

for (const spec of await readReleaseManifest(process.argv[2])) {
  await $`npm dist-tag add ${spec} latest`;
}
