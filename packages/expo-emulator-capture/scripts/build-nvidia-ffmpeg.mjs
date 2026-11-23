// Minimal LGPL FFmpeg build from #107: no external command, decoder, GPL or x264 linkage.
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { createFfmpegSourceArchive } from "./ffmpeg-source.mjs";
import { requireNativeTarget } from "./platform.mjs";

requireNativeTarget("build:nvidia-ffmpeg", ["--target", "linux-x64"]);
const dependencies = join(root, "deps/nvidia");
const source = join(dependencies, "ffmpeg");
const jobs = process.env.EXPO_EMULATOR_CAPTURE_BUILD_JOBS || "4";
if (!/^[1-9][0-9]*$/.test(jobs) || Number(jobs) > 128)
  throw new Error("EXPO_EMULATOR_CAPTURE_BUILD_JOBS must be from 1 to 128");
await $`make -C ${join(dependencies, "nv-codec-headers")} PREFIX=${dependencies} install`;
const flags = [
  "--cc=clang",
  "--disable-everything",
  "--disable-autodetect",
  "--disable-programs",
  "--disable-doc",
  "--disable-shared",
  "--enable-static",
  "--enable-pic",
  "--disable-x86asm",
  "--disable-avdevice",
  "--disable-avfilter",
  "--disable-avformat",
  "--disable-swscale",
  "--disable-swresample",
  "--enable-ffnvcodec",
  "--enable-cuda",
  "--enable-nvenc",
  "--enable-encoder=h264_nvenc",
  "--extra-cflags=-fvisibility=hidden",
];
await $`./configure ${flags}`.cwd(source).env({
  ...process.env,
  PKG_CONFIG_PATH: join(dependencies, "lib/pkgconfig"),
});
await $`make -j${jobs}`.cwd(source);

// Ship the exact pinned FFmpeg source beside its statically linked agent. The
// package also includes this configure recipe and the agent's relinking script.
const output = join(root, "dist/linux-x64");
createFfmpegSourceArchive(source, join(output, "ffmpeg-source.tar.gz"));
