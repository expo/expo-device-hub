#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getChangesetIgnoreList } from "./lib/changeset-ignore.ts";
import { getPublicPackages } from "./lib/public-packages.ts";

const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: pack-packages.ts <outDir>");
  process.exit(1);
}
const root = process.cwd();
const absOutDir = resolve(root, outDir);
await mkdir(absOutDir, { recursive: true });

const ignore = await getChangesetIgnoreList(root);
let packed = 0;
for (const pkg of await getPublicPackages(root)) {
  if (ignore.has(pkg.name)) {
    console.log(`${pkg.name}: skipped (excluded from release)`);
    continue;
  }
  const output = await $`npm pack --pack-destination ${absOutDir} --json`
    .cwd(pkg.dir)
    .text();
  const [result] = JSON.parse(output);
  console.log(
    `${pkg.name}@${pkg.version}: ${result.filename} (${result.entryCount} files)`,
  );
  packed++;
}

if (packed === 0) {
  console.error("::error::No packages to pack.");
  process.exit(1);
}
