import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, downloadVerified, root } from "./common.mjs";
import { requireNativeTarget } from "./platform.mjs";

const target = requireNativeTarget("setup:build");

// Frida Gum supplies the function hook inside the emulator. Same release as the
// Linux experiment in PR #107. Digests: the release assets' published SHA-256.
const fridaVersion = "17.18.0";
const gumDevkits = {
  "darwin-arm64": {
    name: "macos-arm64",
    checksum: "23374b9182189b3cfa3c1d6879c8c8784c9c0a2b22d6258c4bf375cc31592bb4",
  },
  "linux-x64": {
    name: "linux-x86_64",
    checksum: "76970e3b058c6d718c209bb5bf474075b86a987052bd46aa2ee200c2ffc64861",
  },
};
const devkit = gumDevkits[target];
const archiveName = `frida-gum-devkit-${fridaVersion}-${devkit.name}.tar.xz`;
const downloadUrl = `https://github.com/frida/frida/releases/download/${fridaVersion}/${archiveName}`;
const devkitDirectory = join(root, "deps/frida-gum");

await mkdir(devkitDirectory, { recursive: true });
await downloadVerified(downloadUrl, join(root, `deps/${archiveName}`), devkit.checksum);
await $`tar -xJf ${join(root, `deps/${archiveName}`)} -C ${devkitDirectory}`;
