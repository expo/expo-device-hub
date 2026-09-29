import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("build:native");

const kernelHeaderPath = join(root, "build/scale-ptx.h");
const outputDirectory = join(root, "dist/linux-x64");
const captureLibraryPath = "dist/linux-x64/libgpu_capture.so";
const injectorPath = "dist/linux-x64/inject";

if (!existsSync(kernelHeaderPath))
  throw new Error("Run npm run build:scale first");
await mkdir(outputDirectory, { recursive: true });

// Build the injected library with libc++ to match the emulator's C++ ABI.
const captureArgs = [
  "-std=c++17", "-stdlib=libc++", "-shared", "-fPIC", "-O2", "-g", "-Wall", "-Wextra",
  "-ffunction-sections", "-fdata-sections", "-fvisibility=hidden",
  // Headers and sources for capture, hooks, and the embedded CUDA kernel.
  "-I", "build", "-I", "deps/frida-gum", "-I", "nv-codec-headers/include", "-I", "ffmpeg-source",
  "src/capture.cpp", "src/gum-agent.cpp", "-o", captureLibraryPath,
  // Keep the bundled FFmpeg/Gum symbols from colliding with the emulator's.
  "-Wl,-Bsymbolic", "-Wl,--exclude-libs,ALL", "-Wl,--gc-sections",
  "ffmpeg-source/libavcodec/libavcodec.a", "ffmpeg-source/libavutil/libavutil.a",
  "deps/frida-gum/libfrida-gum.a", "-ldl", "-pthread", "-lm", "-lrt", "-lresolv",
];
await $`clang++ ${captureArgs}`;

// Build the separate controller that loads the library into a running emulator.
const injectorArgs = [
  "-std=c++17", "-O2", "-g", "-Wall", "-Wextra", "-ffunction-sections", "-fdata-sections",
  "-I", "deps/frida-core", "src/inject.cpp", "-o", injectorPath,
  "deps/frida-core/libfrida-core.a", "-Wl,--gc-sections", "-Wl,--exclude-libs,ALL",
  "-ldl", "-lm", "-lrt", "-lresolv", "-pthread",
];
await $`clang++ ${injectorArgs}`;

// Keep release artifacts small, with an opt-out for native debugging.
if (process.env.POC_KEEP_DEBUG !== "1")
  await $`strip --strip-unneeded ${injectorPath} ${captureLibraryPath}`;
