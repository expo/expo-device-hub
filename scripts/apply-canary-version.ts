#!/usr/bin/env bun

import { $ } from "bun";
import { getChangesetIgnoreList } from "./lib/changeset-ignore.ts";
import { getPublicPackages } from "./lib/public-packages.ts";

// Rewrites each public package's version into a canary prerelease. Versions
// already bumped by `changeset version` keep that bump; unchanged versions use
// the next minor version:
//
//   <release-version>-canary-<YYYYMMDD>-<short-sha>
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
const ignore = await getChangesetIgnoreList();
const packages = await getPublicPackages();
const canaryVersions = new Map<string, string>();
for (const pkg of packages) {
  if (ignore.has(pkg.name)) {
    console.log(`${pkg.name}: skipped (excluded from release)`);
    continue;
  }

  const path = `${pkg.dir}/package.json`;
  const json = await Bun.file(path).json();
  const committedVersion = JSON.parse(
    await $`git show ${`HEAD:${pkg.path}`}`.text(),
  ).version;
  const baseVersion =
    pkg.version === committedVersion ? nextMinor(pkg.version) : pkg.version;
  const canaryVersion = `${baseVersion}-canary-${date}-${sha}`;
  json.version = canaryVersion;
  canaryVersions.set(pkg.name, canaryVersion);
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(
    `${pkg.name}: ${committedVersion} -> ${pkg.version} -> ${canaryVersion}`,
  );
}

// Runtime dependencies must resolve to this canary's packages, including first releases.
for (const pkg of packages) {
  if (!canaryVersions.has(pkg.name)) continue;
  const path = `${pkg.dir}/package.json`;
  const json = await Bun.file(path).json();
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(json[field] ?? {})) {
      const version = canaryVersions.get(name);
      if (version) json[field][name] = version;
    }
  }
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
}
console.log("::endgroup::");
