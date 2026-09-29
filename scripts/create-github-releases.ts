#!/usr/bin/env bun

import { $ } from "bun";
import { getPublicPackages } from "./lib/public-packages.ts";
import { readTarballs } from "./lib/tarballs.ts";

const dir = process.argv[2] ?? "release-artifacts";

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
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

const packages = await getPublicPackages();

for (const { name, version, path } of await readTarballs(dir)) {
  const tag = `${name}@${version}`;

  const tagged =
    (await $`git rev-parse -q --verify refs/tags/${tag}`.nothrow().quiet())
      .exitCode === 0;
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
  const dir = packages.find((pkg) => pkg.name === name)?.dir;
  const changelog = Bun.file(`${dir}/CHANGELOG.md`);
  if (dir && (await changelog.exists())) {
    const section = changelogSection(await changelog.text(), version);
    if (section) notes = section;
  }

  console.log(`- ${tag}: creating GitHub release with ${path}`);
  await $`gh release create ${tag} ${path} --verify-tag --title ${tag} --notes ${notes}`;
}
