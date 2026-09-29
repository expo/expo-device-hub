import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root, downloadVerified } from "./common.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("setup:build");

// Download the build-only CUDA compiler directly from NVIDIA.
// Digest: https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json
const nvrtcVersion = "12.9.86";
const nvrtcDirectory = join(root, "deps/nvrtc");
const nvrtcArchivePath = join(root, `deps/cuda-nvrtc-${nvrtcVersion}.tar.xz`);
const nvrtcArchiveName = `cuda_nvrtc-linux-x86_64-${nvrtcVersion}-archive.tar.xz`;
const nvrtcDownloadUrl = `https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/linux-x86_64/${nvrtcArchiveName}`;
const nvrtcChecksum = "82913658363892dbc0f2638b070476234476e06e084fed60db861cb7e161a6af";

await downloadVerified(nvrtcDownloadUrl, nvrtcArchivePath, nvrtcChecksum);
await mkdir(nvrtcDirectory, { recursive: true });
await $`tar -xJf ${nvrtcArchivePath} -C deps/nvrtc --strip-components=1`;

// FFmpeg needs the matching NVIDIA encoder API headers at build time.
const codecHeadersDirectory = join(root, "nv-codec-headers");
const codecHeadersVersion = "n13.0.19.0";
const codecHeadersRepository = "https://github.com/FFmpeg/nv-codec-headers.git";
if (!existsSync(codecHeadersDirectory))
  await $`git clone --depth 1 --branch ${codecHeadersVersion} ${codecHeadersRepository}`;

// Fetch the pinned FFmpeg source; build:ffmpeg compiles it separately.
const ffmpegDirectory = join(root, "ffmpeg-source");
const ffmpegVersion = "n8.0.1";
const ffmpegRepository = "https://github.com/FFmpeg/FFmpeg.git";
if (!existsSync(ffmpegDirectory))
  await $`git clone --depth 1 --branch ${ffmpegVersion} ${ffmpegRepository} ffmpeg-source`;

const fridaVersion = "17.18.0";
const releaseUrl = `https://github.com/frida/frida/releases/download/${fridaVersion}`;
const devkitChecksums = {
  core: "3557c4d55718d94b421394f137db96a997901472388bede4cc97fcd2a59b8037",
  gum: "76970e3b058c6d718c209bb5bf474075b86a987052bd46aa2ee200c2ffc64861",
};

// Core provides the injector; Gum provides the hooks inside the emulator.
for (const [kit, checksum] of Object.entries(devkitChecksums)) {
  const devkitDirectory = join(root, `deps/frida-${kit}`);
  const archivePath = `${devkitDirectory}.tar.xz`;
  const archiveName = `frida-${kit}-devkit-${fridaVersion}-linux-x86_64.tar.xz`;
  const downloadUrl = `${releaseUrl}/${archiveName}`;

  await mkdir(devkitDirectory, { recursive: true });
  await downloadVerified(downloadUrl, archivePath, checksum);
  await $`tar -xJf ${archivePath} -C ${devkitDirectory}`;
}
