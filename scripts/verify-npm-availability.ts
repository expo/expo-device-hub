#!/usr/bin/env bun

import { $ } from "bun";
import { readReleaseManifest } from "./lib/release-manifest.ts";

// Based on the exact-version availability check in expo/eas-cli's release.yml.
// npm can serve version metadata before it serves the corresponding tarball.
async function isAvailable(spec: string): Promise<boolean> {
  const version = spec.slice(spec.lastIndexOf("@") + 1);
  const published = await $`npm view ${spec} version --prefer-online`.quiet().nothrow();
  if (published.exitCode !== 0 || published.text().trim() !== version) return false;

  const tarball = await $`npm view ${spec} dist.tarball --prefer-online`.quiet().nothrow();
  const url = tarball.text().trim();
  if (tarball.exitCode !== 0 || !url) return false;

  const download =
    await $`curl --fail --silent --show-error --location --max-time 60 --output /dev/null ${url}`.nothrow();
  return download.exitCode === 0;
}

const packages = await readReleaseManifest(process.argv[2]);
const deadline = Date.now() + 30 * 60_000;
for (const spec of packages) {
  while (!(await isAvailable(spec))) {
    const delay = Math.min(10_000, deadline - Date.now());
    if (delay <= 0) throw new Error(`${spec} was not available on npm after 30 minutes.`);
    console.log(`${spec} is not available on npm yet. Retrying in ${Math.ceil(delay / 1000)}s.`);
    await Bun.sleep(delay);
  }
  console.log(`Verified ${spec} is available on npm.`);
}
