import { skipUnlessNative } from "./platform.mjs";

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";

skipUnlessNative("build:native");

if (!existsSync(join(root, "build/scale-ptx.h")))
  throw new Error("Run npm run build:scale first");
await mkdir(join(root, "dist/linux-x64"), { recursive: true });
const captureArgs = [
  "-std=c++17", "-stdlib=libc++", "-shared", "-fPIC", "-O2", "-g", "-Wall", "-Wextra",
  "-ffunction-sections", "-fdata-sections", "-fvisibility=hidden",
  "-I", "build", "-I", "deps/frida-gum", "-I", "nv-codec-headers/include", "-I", "ffmpeg-source",
  "src/capture.cpp", "src/gum-agent.cpp", "-o", "dist/linux-x64/libgpu_capture.so",
  "-Wl,-Bsymbolic", "-Wl,--exclude-libs,ALL", "-Wl,--gc-sections",
  "ffmpeg-source/libavcodec/libavcodec.a", "ffmpeg-source/libavutil/libavutil.a",
  "deps/frida-gum/libfrida-gum.a", "-ldl", "-pthread", "-lm", "-lrt", "-lresolv",
];
await $`clang++ ${captureArgs}`;
const injectorArgs = [
  "-std=c++17", "-O2", "-g", "-Wall", "-Wextra", "-ffunction-sections", "-fdata-sections",
  "-I", "deps/frida-core", "src/inject.cpp", "-o", "dist/linux-x64/inject",
  "deps/frida-core/libfrida-core.a", "-Wl,--gc-sections", "-Wl,--exclude-libs,ALL",
  "-ldl", "-lm", "-lrt", "-lresolv", "-pthread",
];
await $`clang++ ${injectorArgs}`;
if (process.env.POC_KEEP_DEBUG !== "1")
  await $`strip --strip-unneeded dist/linux-x64/inject dist/linux-x64/libgpu_capture.so`;
