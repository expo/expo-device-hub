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
// Also pins every dependency on another public package, in every dependency
// field, to that package's canary version. A caret range does not match a
// prerelease, so without the pin a canary would resolve the stable release of
// its sibling, or fail to install when the sibling has no release yet.
//
// Run before `changeset publish --tag canary` in the canary release path.

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

// Bump X.Y.Z -> X.(Y+1).0, ignoring any prerelease/build suffix.
function nextMinor(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.\d+/);
  if (!match) throw new Error(`Cannot parse version "${version}"`);
  const [, major, minor] = match;
  return `${major}.${Number(minor) + 1}.0`;
}

const sha = (await $`git rev-parse --short HEAD`.text()).trim();
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const packages = await getPublicPackages();

console.log(`::group::Applying canary versions (date ${date}, commit ${sha})`);
const canaryVersions = new Map<string, string>();
for (const pkg of packages) {
  const committedVersion = JSON.parse(
    await $`git show ${`HEAD:${pkg.path}`}`.text(),
  ).version;
  const baseVersion =
    pkg.version === committedVersion ? nextMinor(pkg.version) : pkg.version;
  const canaryVersion = `${baseVersion}-canary-${date}-${sha}`;
  canaryVersions.set(pkg.name, canaryVersion);
  console.log(
    `${pkg.name}: ${committedVersion} -> ${pkg.version} -> ${canaryVersion}`,
  );
}

for (const pkg of packages) {
  const path = `${pkg.dir}/package.json`;
  const json = await Bun.file(path).json();
  json.version = canaryVersions.get(pkg.name);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(json[field] ?? {})) {
      const version = canaryVersions.get(name);
      if (!version) continue;
      json[field][name] = version;
      console.log(`${pkg.name} ${field}.${name}: ${range} -> ${version}`);
    }
  }
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
}
console.log("::endgroup::");
