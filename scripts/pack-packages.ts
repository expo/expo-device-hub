#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getPublicPackages } from "./lib/public-packages.ts";

const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: pack-packages.ts <outDir> [--canary]");
  process.exit(1);
}
const canary = process.argv.includes("--canary");
const root = process.cwd();
const absOutDir = resolve(root, outDir);
await mkdir(absOutDir, { recursive: true });

let packed = 0;
for (const pkg of await getPublicPackages(root)) {
  if (!canary) {
    const staged = JSON.parse(await $`git show ${`:${pkg.path}`}`.text());
    const previous = JSON.parse(await $`git show ${`HEAD:${pkg.path}`}`.text());
    if (staged.version !== pkg.version)
      throw new Error(`${pkg.path} changed after versioning was staged.`);
    if (staged.version === previous.version) {
      console.log(`${pkg.name}: skipped (version unchanged)`);
      continue;
    }
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
