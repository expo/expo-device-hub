#!/usr/bin/env bun

import { $ } from "bun";
import { getPublicPackages } from "./lib/public-packages.ts";

// Rewrites each public package's version into a canary prerelease built on the
// next minor version:
//
//   <next-minor>-canary-<YYYYMMDD>-<short-sha>
//   e.g. expo-device-hub@0.2.0-canary-20260429-a5e59cf
//
// Run before `changeset publish --tag canary` in the canary release path.

// Bump X.Y.Z -> X.(Y+1).0, ignoring any prerelease/build suffix.
function nextMinor(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.\d+/);
  if (!match) throw new Error(`Cannot parse version "${version}"`);
  const [, major, minor] = match;
  return `${major}.${Number(minor) + 1}.0`;
}

const sha = (await $`git rev-parse --short HEAD`.text()).trim();
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");

console.log(`::group::Applying canary versions (date ${date}, commit ${sha})`);
for (const pkg of await getPublicPackages()) {
  const path = `${pkg.dir}/package.json`;
  const json = await Bun.file(path).json();
  const canaryVersion = `${nextMinor(pkg.version)}-canary-${date}-${sha}`;
  json.version = canaryVersion;
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${pkg.name}: ${pkg.version} -> ${canaryVersion}`);
}
console.log("::endgroup::");
