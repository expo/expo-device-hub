import { skipUnlessNative } from "./platform.mjs";

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root, downloadVerified } from "./common.mjs";

skipUnlessNative("setup:frida");

const version = "17.18.0";
const checksums = {
  core: "3557c4d55718d94b421394f137db96a997901472388bede4cc97fcd2a59b8037",
  gum: "76970e3b058c6d718c209bb5bf474075b86a987052bd46aa2ee200c2ffc64861",
};
for (const [kit, checksum] of Object.entries(checksums)) {
  const directory = join(root, `deps/frida-${kit}`);
  const archive = `${directory}.tar.xz`;
  await mkdir(directory, { recursive: true });
  await downloadVerified(
    `https://github.com/frida/frida/releases/download/${version}/frida-${kit}-devkit-${version}-linux-x86_64.tar.xz`,
    archive, checksum,
  );
  await $`tar -xJf ${archive} -C ${directory}`;
}
