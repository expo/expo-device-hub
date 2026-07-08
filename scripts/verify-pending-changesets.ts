#!/usr/bin/env bun
// Releases are changeset-driven: fail if there is nothing to release.
// Mirrors the "Verify pending changesets" release step. Run from the repo root.
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
for (const name of changesets) {
  const path = `.changeset/${name}`;
  console.log(`----- ${path} -----`);
  console.log((await Bun.file(path).text()).trimEnd());
  console.log("");
}
console.log("::endgroup::");
