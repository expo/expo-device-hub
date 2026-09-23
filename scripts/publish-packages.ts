#!/usr/bin/env bun

import { $ } from "bun";
import { readTarballs } from "./lib/tarballs.ts";

// Publishes the tarballs built on EAS. Mirrors `changeset publish`: versions
// already on npm are skipped, and real releases get a `<name>@<version>` git tag.
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

for (const { name, version, path } of tarballs) {
  const spec = `${name}@${version}`;
  const onNpm = (await $`npm view ${spec} version`.nothrow().quiet()).exitCode === 0;
  if (onNpm) {
    console.log(`- ${spec}: already on npm — skipping`);
    continue;
  }

  const args = ["publish", path, "--access", "public"];
  if (canary) args.push("--tag", "canary");
  if (dryRun) args.push("--dry-run");
  console.log(`- ${spec}: npm ${args.join(" ")}`);
  await $`npm ${args}`;

  if (canary || dryRun) continue;
  const tagged =
    (await $`git rev-parse -q --verify refs/tags/${spec}`.nothrow().quiet()).exitCode === 0;
  if (!tagged) {
    await $`git tag ${spec}`;
    await $`git push origin refs/tags/${spec}`;
  }
}
