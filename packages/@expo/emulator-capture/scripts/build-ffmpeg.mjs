import { skipUnlessNative } from "./platform.mjs";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $, root } from "./common.mjs";

skipUnlessNative("build:ffmpeg");

const jobs = process.env.POC_BUILD_JOBS || "4";
if (!/^[1-9][0-9]*$/.test(jobs) || Number(jobs) > 128)
  throw new Error("POC_BUILD_JOBS must be an integer from 1 to 128");

if (existsSync(join(root, "ffmpeg-source/libavcodec/libavcodec.a")) &&
    existsSync(join(root, "ffmpeg-source/libavutil/libavutil.a"))) {
  console.log("Reusing pinned FFmpeg build; remove ffmpeg-source to rebuild.");
} else {
  await $`make -C nv-codec-headers PREFIX=${join(root, "deps")} install`;
  if (!existsSync(join(root, "ffmpeg-source")))
    await $`git clone --depth 1 --branch n8.0.1 https://github.com/FFmpeg/FFmpeg.git ffmpeg-source`;
  const directory = join(root, "ffmpeg-source");
  const flags = [
    "--cc=clang",
    "--disable-everything", "--disable-autodetect", "--disable-programs", "--disable-doc",
    "--disable-shared", "--enable-static", "--enable-pic", "--disable-x86asm",
    "--disable-avdevice", "--disable-avfilter", "--disable-avformat", "--disable-swscale", "--disable-swresample",
    "--enable-ffnvcodec", "--enable-cuda", "--enable-nvenc", "--enable-encoder=h264_nvenc",
    "--extra-cflags=-fvisibility=hidden",
  ];
  await $`./configure ${flags}`
    .cwd(directory).env({ ...process.env, PKG_CONFIG_PATH: join(root, "deps/lib/pkgconfig") });
  await $`make -j${jobs}`.cwd(directory);
}
