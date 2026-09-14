import { skipUnlessNative } from "./platform.mjs";

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root, downloadVerified } from "./common.mjs";

skipUnlessNative("setup:build");

// Same NVRTC release previously installed through pip, without Python or a venv.
// Digest: https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json
const archive = join(root, "deps/cuda-nvrtc-12.9.86.tar.xz");
await downloadVerified(
  "https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/linux-x86_64/cuda_nvrtc-linux-x86_64-12.9.86-archive.tar.xz",
  archive,
  "82913658363892dbc0f2638b070476234476e06e084fed60db861cb7e161a6af",
);
await mkdir(join(root, "deps/nvrtc"), { recursive: true });
await $`tar -xJf ${archive} -C deps/nvrtc --strip-components=1`;
if (!existsSync(join(root, "nv-codec-headers")))
  await $`git clone --depth 1 --branch n13.0.19.0 https://github.com/FFmpeg/nv-codec-headers.git`;
