import { existsSync } from "node:fs";
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("build:ffmpeg");

const buildJobs = process.env.POC_BUILD_JOBS || "4";
if (!/^[1-9][0-9]*$/.test(buildJobs) || Number(buildJobs) > 128)
  throw new Error("POC_BUILD_JOBS must be an integer from 1 to 128");

const ffmpegDirectory = join(root, "ffmpeg-source");
const dependenciesDirectory = join(root, "deps");
const pkgConfigDirectory = join(root, "deps/lib/pkgconfig");
const codecLibraryPath = join(ffmpegDirectory, "libavcodec/libavcodec.a");
const utilityLibraryPath = join(ffmpegDirectory, "libavutil/libavutil.a");

if (existsSync(codecLibraryPath) && existsSync(utilityLibraryPath)) {
  console.log("Reusing pinned FFmpeg build; remove ffmpeg-source to rebuild.");
} else {
  // Install NVIDIA's headers and pkg-config metadata before configuring FFmpeg.
  await $`make -C nv-codec-headers PREFIX=${dependenciesDirectory} install`;
  const configureFlags = [
    "--cc=clang",
    // Build only the static libraries needed by the injected capture library.
    "--disable-everything", "--disable-autodetect", "--disable-programs", "--disable-doc",
    "--disable-shared", "--enable-static", "--enable-pic", "--disable-x86asm",
    "--disable-avdevice", "--disable-avfilter", "--disable-avformat", "--disable-swscale", "--disable-swresample",
    // Enable GPU frame input and H.264 encoding through NVIDIA's encoder.
    "--enable-ffnvcodec", "--enable-cuda", "--enable-nvenc", "--enable-encoder=h264_nvenc",
    "--extra-cflags=-fvisibility=hidden",
  ];
  const configureEnvironment = { ...process.env, PKG_CONFIG_PATH: pkgConfigDirectory };
  await $`./configure ${configureFlags}`.cwd(ffmpegDirectory).env(configureEnvironment);
  await $`make -j${buildJobs}`.cwd(ffmpegDirectory);
}
