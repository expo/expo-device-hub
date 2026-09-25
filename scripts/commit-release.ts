#!/usr/bin/env bun

import { $ } from "bun";

const branch = process.env.RELEASE_BRANCH;
if (!branch?.startsWith("release/"))
  throw new Error("RELEASE_BRANCH must start with release/.");
await $`git check-ref-format ${`refs/heads/${branch}`}`;
const source = (await $`git rev-parse HEAD`.text()).trim();
const tree = (await $`git write-tree`.text()).trim();

const ref = `refs/heads/${branch}`;
const exists = (await $`git ls-remote --heads origin ${ref}`.text()).trim();
if (!exists) {
  await $`git commit -m ${"chore(release): version packages"}`;
  await $`git push origin ${`HEAD:${ref}`}`;
} else {
  await $`git fetch origin ${ref}`;
  const remote = (await $`git rev-parse FETCH_HEAD`.text()).trim();
  // Reuse the tested commit when a failed workflow rebuilds the same source.
  const [remoteTree, parent, subject] = (
    await $`git show -s --format=%T%n%P%n%s ${remote}`.text()
  )
    .trim()
    .split("\n");
  if (
    remoteTree !== tree ||
    parent !== source ||
    subject !== "chore(release): version packages"
  ) {
    throw new Error(
      "The release branch does not match this run's source and version changes.",
    );
  }
  await $`git checkout --detach ${remote}`;
  console.log(`Reusing release commit ${remote}.`);
}
