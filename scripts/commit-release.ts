#!/usr/bin/env bun

import { $ } from "bun";

// Apply exactly the version changes that passed the EAS build and tests.
const patch = process.argv[2];
const branch = process.env.RELEASE_BRANCH;
if (!patch || !branch)
  throw new Error(
    "Usage: RELEASE_BRANCH=<branch> commit-release.ts <version.patch>",
  );
await $`git check-ref-format ${`refs/heads/${branch}`}`;
const source = (await $`git rev-parse HEAD`.text()).trim();
await $`git apply --index ${patch}`;
const tree = (await $`git write-tree`.text()).trim();

await $`git fetch origin ${`refs/heads/${branch}`}`;
const remote = (await $`git rev-parse FETCH_HEAD`.text()).trim();
if (remote === source) {
  await $`git commit -m ${"chore(release): version packages"}`;
  await $`git push origin ${`HEAD:refs/heads/${branch}`}`;
} else {
  // Rerunning the same workflow after a publish/tag failure rebuilds the same
  // source. Reuse its version commit instead of generating a different tag target.
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
      "The release branch advanced to different changes; start a release from its latest commit.",
    );
  }
  await $`git checkout --detach ${remote}`;
  console.log(`Reusing release commit ${remote}.`);
}
