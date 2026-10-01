#!/usr/bin/env bun

import { $ } from "bun";

const branch = process.env.RELEASE_BRANCH;
if (!branch?.startsWith("release/"))
  throw new Error("RELEASE_BRANCH must start with release/.");
await $`git check-ref-format ${`refs/heads/${branch}`}`;
const ref = `refs/heads/${branch}`;
await $`git commit -m ${"chore(release): version packages"}`;
await $`git push origin ${`HEAD:${ref}`}`;
