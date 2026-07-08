#!/usr/bin/env bun
// Preview each published package's changelog and npm tarball without publishing.
// Mirrors the "Preview (dry run)" release step. Run from the repo root.
import { $ } from "bun";

const PUBLIC_PACKAGE_DIRS = [
  "packages/expo-device-hub",
  "packages/@expo/hub-client",
];

for (const dir of PUBLIC_PACKAGE_DIRS) {
  const changelog = Bun.file(`${dir}/CHANGELOG.md`);

  console.log(`::group::${dir} — CHANGELOG.md`);
  if (await changelog.exists()) {
    console.log((await changelog.text()).split("\n").slice(0, 40).join("\n"));
  } else {
    console.log("(no CHANGELOG.md — no changeset for this package)");
  }
  console.log("::endgroup::");

  console.log(`::group::${dir} — npm publish --dry-run`);
  // .nothrow() so a pack warning doesn't fail the preview.
  await $`npm publish --dry-run --access public`.cwd(dir).nothrow();
  console.log("::endgroup::");
}
