#!/usr/bin/env bun

import { $ } from "bun";
import { readTarballs } from "./lib/tarballs.ts";

// Creates a GitHub release for every tarball that publish-packages.ts tagged in
// this run, attaching the tarball built on EAS.
//
//   ./scripts/create-github-releases.ts release-artifacts

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
  return lines.slice(start + 1, end).join("\n").trim();
}

async function packageDir(name: string): Promise<string | undefined> {
  const { getPublicPackages } = await import("./lib/public-packages.ts");
  return (await getPublicPackages()).find((pkg) => pkg.name === name)?.dir;
}

for (const { name, version, path } of await readTarballs(dir)) {
  const tag = `${name}@${version}`;

  // Only release packages tagged in this run (publish-packages.ts creates the tag).
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
  const dir = await packageDir(name);
  const changelog = Bun.file(`${dir}/CHANGELOG.md`);
  if (dir && (await changelog.exists())) {
    const section = changelogSection(await changelog.text(), version);
    if (section) notes = section;
  }

  console.log(`- ${tag}: creating GitHub release with ${path}`);
  await $`gh release create ${tag} ${path} --verify-tag --title ${tag} --notes ${notes}`;
}
