import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $, root, downloadVerified } from "./common.mjs";
import { paths, requireFiles, requireSourceDevkits } from "./build-paths.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("setup:build");
requireSourceDevkits();

const sourceInputs = [
  ["POC_FFMPEG_SOURCE_DIR", paths.ffmpegSourceDirectory, ["configure", "libavcodec/avcodec.h"]],
  ["POC_NV_CODEC_HEADERS_SOURCE_DIR", paths.codecHeadersDirectory, ["ffnvcodec.pc.in", "include/ffnvcodec/nvEncodeAPI.h"]],
  ["POC_FRIDA_GUM_DEVKIT_DIR", paths.gumDevkitDirectory, ["frida-gum.h", "libfrida-gum.a"]],
  ["POC_FRIDA_CORE_DEVKIT_DIR", paths.coreDevkitDirectory, ["frida-core.h", "libfrida-core.a"]],
];
// Validate every override before doing any setup work. In particular, never
// populate a misspelled source path with a downloaded default dependency.
for (const [variable, directory, files] of sourceInputs)
  if (process.env[variable] !== undefined) requireFiles(directory, files, variable);
if (process.env.POC_NVRTC_LIBRARY !== undefined)
  requireFiles(dirname(paths.nvrtcLibraryPath), [paths.nvrtcLibraryPath], "POC_NVRTC_LIBRARY");

async function cachedDownload(url, archive, checksum) {
  if (process.env.POC_OFFLINE === "1" && !existsSync(archive))
    throw new Error(`POC_OFFLINE=1: missing cached archive ${archive}. Supply the dependency path or prepare it while online.`);
  await downloadVerified(url, archive, checksum);
}

// Download the build-only CUDA compiler directly from NVIDIA.
// Digest: https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json
const nvrtcVersion = "12.9.86";
const nvrtcDirectory = join(root, "deps/nvrtc");
const nvrtcArchivePath = join(root, `deps/cuda-nvrtc-${nvrtcVersion}.tar.xz`);
const nvrtcArchiveName = `cuda_nvrtc-linux-x86_64-${nvrtcVersion}-archive.tar.xz`;
const nvrtcDownloadUrl = `https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/linux-x86_64/${nvrtcArchiveName}`;
const nvrtcChecksum = "82913658363892dbc0f2638b070476234476e06e084fed60db861cb7e161a6af";

if (process.env.POC_NVRTC_LIBRARY === undefined && !existsSync(paths.nvrtcLibraryPath)) {
  await cachedDownload(nvrtcDownloadUrl, nvrtcArchivePath, nvrtcChecksum);
  await mkdir(nvrtcDirectory, { recursive: true });
  await $`tar -xJf ${nvrtcArchivePath} -C ${nvrtcDirectory} --strip-components=1`;
}

// FFmpeg needs the matching NVIDIA encoder API headers at build time.
const codecHeadersDirectory = paths.codecHeadersDirectory;
const codecHeadersVersion = "n13.0.19.0";
const codecHeadersRepository = "https://github.com/FFmpeg/nv-codec-headers.git";
if (!existsSync(codecHeadersDirectory)) {
  if (process.env.POC_OFFLINE === "1")
    throw new Error(`POC_OFFLINE=1: missing NVIDIA codec headers at ${codecHeadersDirectory}`);
  await $`git clone --depth 1 --branch ${codecHeadersVersion} ${codecHeadersRepository} ${codecHeadersDirectory}`;
}

// Fetch the pinned FFmpeg source; build:ffmpeg compiles it separately.
const ffmpegDirectory = paths.ffmpegSourceDirectory;
const ffmpegVersion = "n8.0.1";
const ffmpegRepository = "https://github.com/FFmpeg/FFmpeg.git";
if (!existsSync(ffmpegDirectory)) {
  if (process.env.POC_OFFLINE === "1")
    throw new Error(`POC_OFFLINE=1: missing FFmpeg source at ${ffmpegDirectory}`);
  await $`git clone --depth 1 --branch ${ffmpegVersion} ${ffmpegRepository} ${ffmpegDirectory}`;
}

const fridaVersion = "17.18.0";
const releaseUrl = `https://github.com/frida/frida/releases/download/${fridaVersion}`;
const devkitChecksums = {
  core: "3557c4d55718d94b421394f137db96a997901472388bede4cc97fcd2a59b8037",
  gum: "76970e3b058c6d718c209bb5bf474075b86a987052bd46aa2ee200c2ffc64861",
};

// Core provides the injector; Gum provides the hooks inside the emulator.
for (const [kit, checksum] of Object.entries(devkitChecksums)) {
  const devkitDirectory = kit === "core" ? paths.coreDevkitDirectory : paths.gumDevkitDirectory;
  if (process.env[`POC_FRIDA_${kit.toUpperCase()}_DEVKIT_DIR`] !== undefined) continue;
  if ([`frida-${kit}.h`, `libfrida-${kit}.a`].every(file => existsSync(join(devkitDirectory, file)))) continue;
  const archivePath = `${devkitDirectory}.tar.xz`;
  const archiveName = `frida-${kit}-devkit-${fridaVersion}-linux-x86_64.tar.xz`;
  const downloadUrl = `${releaseUrl}/${archiveName}`;

  await mkdir(devkitDirectory, { recursive: true });
  await cachedDownload(downloadUrl, archivePath, checksum);
  await $`tar -xJf ${archivePath} -C ${devkitDirectory}`;
}

for (const [variable, directory, files] of sourceInputs) requireFiles(directory, files, variable);
requireFiles(dirname(paths.nvrtcLibraryPath), [paths.nvrtcLibraryPath], "NVRTC");
