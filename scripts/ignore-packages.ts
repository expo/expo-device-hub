#!/usr/bin/env bun

import { getChangesetIgnoreList } from "./lib/changeset-ignore.ts";
import { getPublicPackages } from "./lib/public-packages.ts";

const root = process.cwd();

const ignore = await getChangesetIgnoreList(root);
const packages = await getPublicPackages(root);

for (const pkg of packages) {
  if (!ignore.has(pkg.name)) continue;

  console.log(`Marking ${pkg.name} (${pkg.dir}) private for publish`);
  const file = Bun.file(`${root}/${pkg.path}`);
  const json = await file.json();
  json.private = true;
  await Bun.write(file, `${JSON.stringify(json, null, 2)}\n`);
}
