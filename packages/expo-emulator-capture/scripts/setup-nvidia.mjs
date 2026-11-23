// Build-only dependencies from PR #107. Runtime needs the NVIDIA driver, not NVRTC.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, downloadVerified, root } from "./common.mjs";
import { requireNativeTarget } from "./platform.mjs";

requireNativeTarget("setup:nvidia", ["--target", "linux-x64"]);
const dependencies = join(root, "deps/nvidia");
await mkdir(dependencies, { recursive: true });

// Validate cached source checkouts too. Never compile a moved tag or modified dependency.
for (const [name, repository, tag, commit] of [
  ["ffmpeg", "FFmpeg", "n8.0.1", "894da5ca7d742e4429ffb2af534fcda0103ef593"],
  [
    "nv-codec-headers",
    "nv-codec-headers",
    "n13.0.19.0",
    "e844e5b26f46bb77479f063029595293aa8f812d",
  ],
]) {
  const directory = join(dependencies, name);
  if (!existsSync(directory))
    await $`git clone --depth 1 --branch ${tag} https://github.com/FFmpeg/${repository}.git ${directory}`;
  const actual = (await $`git -C ${directory} rev-parse HEAD`.quiet()).stdout.toString().trim();
  const changed = (await $`git -C ${directory} diff HEAD --`.quiet()).stdout.toString().trim();
  if (actual !== commit || changed)
    throw new Error(`${directory} differs from pinned ${commit}; remove it and retry`);
}

// PTX JIT is not covered by CUDA minor-version compatibility. CUDA 12.8's
// compiler targets the advertised R570 driver; compute_75 alone is insufficient.
const version = "12.8.93";
const archive = join(dependencies, `cuda-nvrtc-${version}.tar.xz`);
const url = `https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/linux-x86_64/cuda_nvrtc-linux-x86_64-${version}-archive.tar.xz`;
await downloadVerified(
  url,
  archive,
  "992f5e4d95cb499f41e442245efa877dbd60c711451afe680a26700d61eb3843",
);
await mkdir(join(dependencies, "nvrtc"), { recursive: true });
await $`tar -xJf ${archive} -C ${join(dependencies, "nvrtc")} --strip-components=1`;
