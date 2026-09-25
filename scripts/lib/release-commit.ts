import { $ } from "bun";
import { getChangesetIgnoreList } from "./changeset-ignore.ts";
import { getPublicPackages } from "./public-packages.ts";

export async function readReleaseCommit() {
  const sha = (await $`git rev-parse HEAD`.text()).trim();
  const subject = (await $`git log -1 --format=%s`.text()).trim();
  if (subject !== "chore(release): version packages") {
    throw new Error(`${sha} is not a release version commit.`);
  }

  const parents = (await $`git rev-list --parents -n 1 HEAD`.text())
    .trim()
    .split(/\s+/);
  if (parents.length !== 2) {
    throw new Error(
      "Expected a release commit with one available parent; fetch at least two commits.",
    );
  }

  const ignore = await getChangesetIgnoreList();
  const packages = new Map<string, string>();
  for (const pkg of await getPublicPackages()) {
    if (ignore.has(pkg.name)) continue;
    const current = JSON.parse(
      await $`git show ${`${sha}:${pkg.path}`}`.text(),
    );
    const previous = JSON.parse(
      await $`git show ${`${parents[1]}:${pkg.path}`}`.text(),
    );
    if (current.name !== pkg.name || current.version !== pkg.version) {
      throw new Error(`${pkg.path} does not match the release commit.`);
    }
    if (previous.version !== current.version)
      packages.set(pkg.name, pkg.version);
  }
  if (packages.size === 0)
    throw new Error(`${sha} does not version any publishable packages.`);
  return { sha, packages };
}
