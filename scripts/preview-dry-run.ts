#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { getPublicPackages } from "./lib/public-packages.ts";

const artifactsDir = `${process.cwd()}/release-artifacts`;
await mkdir(artifactsDir, { recursive: true });

for (const { dir } of await getPublicPackages()) {
  const changelog = Bun.file(`${dir}/CHANGELOG.md`);

  console.log(`::group::${dir} — CHANGELOG.md`);
  if (await changelog.exists()) {
    console.log((await changelog.text()).split("\n").slice(0, 40).join("\n"));
  } else {
    console.log("(no CHANGELOG.md — no changeset for this package)");
  }
  console.log("::endgroup::");

  console.log(`::group::${dir} — npm pack`);
  await $`npm pack --pack-destination ${artifactsDir}`.cwd(dir);
  console.log("::endgroup::");
}

console.log("::group::Tarballs in release-artifacts/");
await $`ls -lh ${artifactsDir}`;
console.log("::endgroup::");
