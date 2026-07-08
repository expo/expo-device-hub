#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { getPublicPackages } from "./lib/public-packages.ts";

const artifactsDir = `${process.cwd()}/release-artifacts`;
await mkdir(artifactsDir, { recursive: true });

function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

for (const pkg of await getPublicPackages()) {
  const tag = `${pkg.name}@${pkg.version}`;

  // Only release packages tagged in this run (changeset publish creates the tag).
  const tagged =
    (await $`git rev-parse -q --verify refs/tags/${tag}`.nothrow().quiet()).exitCode === 0;
  if (!tagged) {
    console.log(`- ${tag}: no tag (not published this run) — skipping`);
    continue;
  }

  const alreadyReleased =
    (await $`gh release view ${tag}`.nothrow().quiet()).exitCode === 0;
  if (alreadyReleased) {
    console.log(`- ${tag}: GitHub release already exists — skipping`);
    continue;
  }

  let notes = `Release ${tag}`;
  const changelog = Bun.file(`${pkg.dir}/CHANGELOG.md`);
  if (await changelog.exists()) {
    const section = changelogSection(await changelog.text(), pkg.version);
    if (section) notes = section;
  }

  const packOutput = await $`npm pack --pack-destination ${artifactsDir} --json`.cwd(pkg.dir).text();
  const tarball = `${artifactsDir}/${JSON.parse(packOutput)[0].filename}`;

  console.log(`- ${tag}: creating GitHub release with ${JSON.parse(packOutput)[0].filename}`);
  await $`gh release create ${tag} ${tarball} --verify-tag --title ${tag} --notes ${notes}`;
}
