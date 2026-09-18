// An explicit online step. Proprietary compiler binaries never enter the source archive.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $, root, downloadVerified } from "./common.mjs";
import { paths, requireFiles } from "./build-paths.mjs";
import { supportsNative } from "./platform.mjs";

if (!supportsNative()) throw new Error("Prepare NVRTC on Linux x64 or through source-container.sh");
if (process.env.POC_NVRTC_LIBRARY) {
  requireFiles(dirname(paths.nvrtcLibraryPath), [paths.nvrtcLibraryPath], "NVRTC override");
} else if (!existsSync(paths.nvrtcLibraryPath)) {
  if (process.env.POC_OFFLINE === "1") throw new Error("POC_OFFLINE=1: supply POC_NVRTC_LIBRARY or prepare tools online first");
  const archive = join(root, "deps/cuda-nvrtc-12.9.86.tar.xz");
  await downloadVerified(
    "https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/linux-x86_64/cuda_nvrtc-linux-x86_64-12.9.86-archive.tar.xz",
    archive, "82913658363892dbc0f2638b070476234476e06e084fed60db861cb7e161a6af",
  );
  const target = join(root, "deps/nvrtc");
  await mkdir(target, { recursive: true });
  await $`tar -xJf ${archive} -C ${target} --strip-components=1`;
}
console.log(`NVRTC available at ${paths.nvrtcLibraryPath}`);
