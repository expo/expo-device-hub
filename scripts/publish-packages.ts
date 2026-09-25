#!/usr/bin/env bun

import { $ } from "bun";
import { getPublicPackages } from "./lib/public-packages.ts";
import { readTarballs } from "./lib/tarballs.ts";

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: publish-packages.ts <dir> [--canary] [--dry-run]");
  process.exit(1);
}
const canary = flags.includes("--canary");
const dryRun = flags.includes("--dry-run");

const tarballs = await readTarballs(dir);
if (tarballs.length === 0) {
  console.error(`::error::No tarballs found in ${dir}.`);
  process.exit(1);
}

const releaseSha =
  canary || dryRun ? undefined : (await $`git rev-parse HEAD`.text()).trim();
if (releaseSha) {
  const packages = await getPublicPackages();
  for (const { name, version } of tarballs) {
    if (!packages.some((pkg) => pkg.name === name && pkg.version === version))
      throw new Error(`${name}@${version} does not match the release commit.`);
  }
}

for (const { name, version, path } of tarballs) {
  const spec = `${name}@${version}`;
  const onNpm =
    (await $`npm view ${spec} version`.nothrow().quiet()).exitCode === 0;
  if (onNpm) {
    console.log(`- ${spec}: already on npm — skipping publication`);
  } else {
    const args = ["publish", path, "--access", "public"];
    if (canary) args.push("--tag", "canary");
    if (dryRun) args.push("--dry-run");
    console.log(`- ${spec}: npm ${args.join(" ")}`);
    await $`npm ${args}`;
  }

  if (!releaseSha) continue;
  const ref = `refs/tags/${spec}`;
  const remoteTag = (await $`git ls-remote --tags origin ${ref}`.text()).trim();
  if (remoteTag) {
    // Reuse an existing remote tag, including an annotated tag. A conflicting
    // local tag makes this fetch fail rather than overwriting either tag.
    await $`git fetch origin ${`${ref}:${ref}`}`;
  }
  const localTag = await $`git rev-parse -q --verify ${`${ref}^{commit}`}`
    .nothrow()
    .quiet();
  if (localTag.exitCode === 0) {
    if (localTag.text().trim() !== releaseSha) {
      throw new Error(
        `${spec} points to a different commit than ${releaseSha}.`,
      );
    }
  } else {
    await $`git tag ${spec} ${releaseSha}`;
  }
  // Push even when the tag already existed locally after an earlier failed push.
  await $`git push origin ${ref}`;
}
