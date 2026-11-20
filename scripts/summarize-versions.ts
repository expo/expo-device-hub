#!/usr/bin/env bun

import { $ } from "bun";
import { getPublicPackages } from "./lib/public-packages.ts";

// Capture the versions for this release before committing the version bump.
// The optional manifest feeds both verification and stable promotion.
const specs: string[] = [];
for (const pkg of await getPublicPackages()) {
  const committed = JSON.parse(await $`git show ${`HEAD:${pkg.path}`}`.text());
  if (pkg.version === committed.version) continue;
  const spec = `${pkg.name}@${pkg.version}`;
  console.log(`Releasing ${spec}`);
  specs.push(spec);
}

const manifest = process.argv[2];
if (manifest) {
  if (!specs.length) throw new Error("No package versions changed for this release.");
  await Bun.write(manifest, specs.join("\n") + "\n");
}
