#!/usr/bin/env bun

import { $ } from "bun";
import { getPublicPackages } from "./lib/public-packages.ts";

// Rewrites each public package's version into a canary prerelease. Versions
// already bumped by `changeset version` keep that bump; unchanged versions use
// the next minor version:
//
//   <release-version>-canary-<YYYYMMDD>-<short-sha>
//   e.g. expo-device-hub@0.2.0-canary-20260429-a5e59cf
//
// Run before `changeset publish --tag canary` in the canary release path.
//
// CANARY_ID overrides the `<YYYYMMDD>-<short-sha>` suffix. The release workflow
// sets it so that the EAS cache build and the GitHub release write identical
// versions, and so identical Turborepo hashes.

// Bump X.Y.Z -> X.(Y+1).0, ignoring any prerelease/build suffix.
function nextMinor(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.\d+/);
  if (!match) throw new Error(`Cannot parse version "${version}"`);
  const [, major, minor] = match;
  return `${major}.${Number(minor) + 1}.0`;
}

const canaryId =
  process.env.CANARY_ID ||
  `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${(
    await $`git rev-parse --short HEAD`.text()
  ).trim()}`;
if (!/^\d{8}-[0-9a-f]{7,40}$/.test(canaryId)) {
  throw new Error(`Invalid canary id "${canaryId}", expected <YYYYMMDD>-<sha>`);
}

console.log(`::group::Applying canary versions (${canaryId})`);
for (const pkg of await getPublicPackages()) {
  const path = `${pkg.dir}/package.json`;
  const json = await Bun.file(path).json();
  const committedVersion = JSON.parse(await $`git show ${`HEAD:${pkg.path}`}`.text()).version;
  const baseVersion = pkg.version === committedVersion ? nextMinor(pkg.version) : pkg.version;
  const canaryVersion = `${baseVersion}-canary-${canaryId}`;
  json.version = canaryVersion;
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${pkg.name}: ${committedVersion} -> ${pkg.version} -> ${canaryVersion}`);
}
console.log("::endgroup::");
