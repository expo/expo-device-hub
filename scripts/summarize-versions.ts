#!/usr/bin/env bun

import { $ } from "bun";
import { getPublicPackages } from "./lib/public-packages.ts";

// Capture the versions for this release before committing the version bump.
// The optional manifest feeds both verification and stable promotion.
const manifest = process.argv[2];
const specs: string[] = [];
console.log("::group::Versions after changeset version");
for (const pkg of await getPublicPackages()) {
  const spec = `${pkg.name}@${pkg.version}`;
  console.log(spec);
  if (!manifest) continue;

  const committed = JSON.parse(await $`git show ${`HEAD:${pkg.path}`}`.text());
  if (pkg.version !== committed.version) specs.push(spec);
}
console.log("::endgroup::");

if (manifest) {
  if (!specs.length) throw new Error("No package versions changed for this release.");
  await Bun.write(manifest, specs.join("\n") + "\n");
}
