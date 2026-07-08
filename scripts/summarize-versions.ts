#!/usr/bin/env bun
// Print the current version of each published package (grouped for the Actions log).
// Mirrors the "Summarize versions" release step. Run from the repo root.
const PUBLIC_PACKAGES = [
  { name: "expo-device-hub", dir: "packages/expo-device-hub" },
  { name: "@expo/hub-client", dir: "packages/@expo/hub-client" },
];

console.log("::group::Versions after changeset version");
for (const pkg of PUBLIC_PACKAGES) {
  const { version } = await Bun.file(`${pkg.dir}/package.json`).json();
  console.log(`${pkg.name}@${version}`);
}
console.log("::endgroup::");
