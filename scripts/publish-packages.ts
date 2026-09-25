#!/usr/bin/env bun

import { $ } from "bun";
import { readTarballs } from "./lib/tarballs.ts";
import { readReleaseCommit } from "./lib/release-commit.ts";

// Publishes the tarballs built on EAS. Mirrors `changeset publish`: versions
// already on npm are not republished. Real releases reconcile tags for the
// packages versioned by the checked-out release commit, including on retries.
//
//   ./scripts/publish-packages.ts release-artifacts            # real release
//   ./scripts/publish-packages.ts release-artifacts --canary   # dist-tag canary, no git tags
//   add --dry-run to run `npm publish --dry-run`

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

const release = canary || dryRun ? undefined : await readReleaseCommit();
if (release) {
  // Check all release artifacts before publishing or tagging any of them.
  for (const [name, version] of release.packages) {
    const artifact = tarballs.find((pkg) => pkg.name === name);
    if (!artifact || artifact.version !== version) {
      throw new Error(
        `Expected a tarball for ${name}@${version} from ${release.sha}.`,
      );
    }
  }
}

for (const { name, version, path } of tarballs) {
  const spec = `${name}@${version}`;
  if (release && !release.packages.has(name)) {
    console.log(`- ${spec}: not versioned by this release — skipping`);
    continue;
  }
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

  if (!release) continue;
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
    if (localTag.text().trim() !== release.sha) {
      throw new Error(
        `${spec} points to a different commit than ${release.sha}.`,
      );
    }
  } else {
    await $`git tag ${spec} ${release.sha}`;
  }
  // Push even when the tag already existed locally after an earlier failed push.
  await $`git push origin ${ref}`;
}
