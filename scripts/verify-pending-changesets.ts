#!/usr/bin/env bun

import { Glob } from "bun";

const changesets: string[] = [];
for await (const file of new Glob("*.md").scan({ cwd: ".changeset" })) {
  if (file === "README.md") continue;
  changesets.push(file);
}

if (changesets.length === 0) {
  console.log(
    "::error::No changesets found in .changeset/. Add one with `bun changeset` in your PR before releasing.",
  );
  process.exit(1);
}

console.log(`Found ${changesets.length} changeset(s) to release.`);
console.log("::group::Pending changesets");
const released = new Set<string>();
for (const name of changesets) {
  const path = `.changeset/${name}`;
  const text = await Bun.file(path).text();
  console.log(`----- ${path} -----`);
  console.log(text.trimEnd());
  console.log("");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  for (const match of frontmatter.matchAll(/^\s*["']?([^"':\s]+)["']?\s*:/gm)) {
    released.add(match[1]!);
  }
}
console.log("::endgroup::");

// The Hub installs the expo-emulator-capture version of its own release, so an agent release
// reaches Hub users only with a Hub release.
if (released.has("expo-emulator-capture") && !released.has("expo-device-hub")) {
  console.log(
    "::error::A changeset releases expo-emulator-capture but none releases expo-device-hub. The Hub pins the agent version of its own release; add expo-device-hub to the changeset.",
  );
  process.exit(1);
}
