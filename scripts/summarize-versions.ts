#!/usr/bin/env bun

import { getPublicPackages } from "./lib/public-packages.ts";

console.log("::group::Versions after changeset version");
for (const pkg of await getPublicPackages()) {
  console.log(`${pkg.name}@${pkg.version}`);
}
console.log("::endgroup::");
