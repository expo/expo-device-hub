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

const version = "12.9.86";
const archive = join(dependencies, `cuda-nvrtc-${version}.tar.xz`);
const url = `https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/linux-x86_64/cuda_nvrtc-linux-x86_64-${version}-archive.tar.xz`;
await downloadVerified(
  url,
  archive,
  "82913658363892dbc0f2638b070476234476e06e084fed60db861cb7e161a6af",
);
await mkdir(join(dependencies, "nvrtc"), { recursive: true });
await $`tar -xJf ${archive} -C ${join(dependencies, "nvrtc")} --strip-components=1`;
