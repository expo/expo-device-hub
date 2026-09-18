import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { $, root } from "./common.mjs";
import { paths, requireFiles, requireSourceDevkits } from "./build-paths.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("build:native");
requireSourceDevkits();

const { buildDirectory, outputDirectory, kernelHeaderPath, ffmpegSourceDirectory, ffmpegBuildDirectory, codecHeadersDirectory, gumDevkitDirectory, coreDevkitDirectory } = paths;
const captureLibraryPath = join(outputDirectory, "libgpu_capture.so");
const injectorPath = join(outputDirectory, "inject");

requireFiles(buildDirectory, [kernelHeaderPath], "Run npm run build:scale first");
requireFiles(ffmpegSourceDirectory, ["libavcodec/avcodec.h", "libavutil/avutil.h"], "FFmpeg source");
requireFiles(ffmpegBuildDirectory, ["config.h", "ffbuild/config.mak", "libavutil/avconfig.h", "libavcodec/libavcodec.a", "libavutil/libavutil.a"], "Run npm run build:ffmpeg first");
requireFiles(codecHeadersDirectory, ["include/ffnvcodec/dynlink_cuda.h"], "NVIDIA codec headers");
requireFiles(gumDevkitDirectory, ["frida-gum.h", "libfrida-gum.a"], "Frida Gum devkit");
requireFiles(coreDevkitDirectory, ["frida-core.h", "libfrida-core.a"], "Frida Core devkit");
requireFiles(root, [paths.nvrtcLibraryPath], "NVRTC build input for provenance");
await mkdir(outputDirectory, { recursive: true });

// Build the injected library with libc++ to match the emulator's C++ ABI.
const captureArgs = [
  "-std=c++17", "-stdlib=libc++", "-shared", "-fPIC", "-O2", "-g", "-Wall", "-Wextra",
  "-ffunction-sections", "-fdata-sections", "-fvisibility=hidden",
  // Headers and sources for capture, hooks, and the embedded CUDA kernel.
  "-I", buildDirectory, "-I", gumDevkitDirectory, "-I", join(codecHeadersDirectory, "include"),
  // Generated FFmpeg headers live in the object directory; public headers stay
  // in the source tree when using an out-of-tree or modified dependency build.
  "-I", ffmpegBuildDirectory, "-I", ffmpegSourceDirectory,
  "src/capture.cpp", "src/gum-agent.cpp", "-o", captureLibraryPath,
  // Keep the bundled FFmpeg/Gum symbols from colliding with the emulator's.
  "-Wl,-Bsymbolic", "-Wl,--exclude-libs,ALL", "-Wl,--gc-sections",
  join(ffmpegBuildDirectory, "libavcodec/libavcodec.a"), join(ffmpegBuildDirectory, "libavutil/libavutil.a"),
  join(gumDevkitDirectory, "libfrida-gum.a"), "-ldl", "-pthread", "-lm", "-lrt", "-lresolv",
];
await $`clang++ ${captureArgs}`;

// Build the separate controller that loads the library into a running emulator.
const injectorArgs = [
  "-std=c++17", "-O2", "-g", "-Wall", "-Wextra", "-ffunction-sections", "-fdata-sections",
  "-I", coreDevkitDirectory, "src/inject.cpp", "-o", injectorPath,
  join(coreDevkitDirectory, "libfrida-core.a"), "-Wl,--gc-sections", "-Wl,--exclude-libs,ALL",
  "-ldl", "-lm", "-lrt", "-lresolv", "-pthread",
];
await $`clang++ ${injectorArgs}`;

// Keep release artifacts small, with an opt-out for native debugging.
if (process.env.POC_KEEP_DEBUG !== "1")
  await $`strip --strip-unneeded ${injectorPath} ${captureLibraryPath}`;

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// Record the actual inputs, including local edits, rather than claiming an
// upstream revision describes an arbitrary replacement source checkout.
async function fingerprintTree(directory) {
  const entries = [];
  const excluded = new Set([buildDirectory, ffmpegBuildDirectory, outputDirectory].filter(path => path !== directory));
  async function visit(path, ancestors) {
    const canonical = await realpath(path);
    if (ancestors.has(canonical)) throw new Error(`Source directory contains a symlink cycle: ${path}`);
    const nextAncestors = new Set([...ancestors, canonical]);
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.name === ".git" || item.name === "build" || item.name === "__pycache__" || item.name.endsWith(".pyc")) continue;
      const child = join(path, item.name);
      if (excluded.has(child)) continue;
      const sourcePath = relative(directory, child).split("\\").join("/");
      if (item.isSymbolicLink()) {
        entries.push({ path: sourcePath, type: "symlink", target: await readlink(child) });
        continue;
      }
      const kind = item;
      if (kind.isDirectory()) await visit(child, nextAncestors);
      else if (kind.isFile()) entries.push({ path: sourcePath, type: "file", sha256: await sha256(child) });
    }
  }
  await visit(directory, new Set());
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.type < b.type ? -1 : 1);
  return { directory, sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}

const inputFiles = [
  kernelHeaderPath, paths.nvrtcLibraryPath,
  join(ffmpegBuildDirectory, "config.h"), join(ffmpegBuildDirectory, "ffbuild/config.mak"),
  join(ffmpegBuildDirectory, "libavcodec/libavcodec.a"), join(ffmpegBuildDirectory, "libavutil/libavutil.a"),
  join(gumDevkitDirectory, "frida-gum.h"), join(gumDevkitDirectory, "libfrida-gum.a"),
  join(coreDevkitDirectory, "frida-core.h"), join(coreDevkitDirectory, "libfrida-core.a"),
];
const provenance = {
  schemaVersion: 1,
  paths,
  sourceBuild: process.env.POC_SOURCE_BUILD === "1",
  ffmpegBuild: existsSync(join(ffmpegBuildDirectory, "expo-build-inputs.json"))
    ? JSON.parse(await readFile(join(ffmpegBuildDirectory, "expo-build-inputs.json"), "utf8")) : null,
  fingerprintAlgorithm: "sha256 of UTF-8 JSON.stringify(entries), sorted by path then type; file SHA-256 hashes content; symlinks record targets without following; excludes .git, build, __pycache__, .pyc and configured output directories",
  sources: {
    expo: await fingerprintTree(join(root, "src")),
    buildScripts: await fingerprintTree(join(root, "scripts")),
    ffmpeg: await fingerprintTree(ffmpegSourceDirectory),
    nvCodecHeaders: await fingerprintTree(codecHeadersDirectory),
  },
  inputs: await Promise.all(inputFiles.map(async path => ({ path, sha256: await sha256(path) }))),
  commands: { capture: ["clang++", ...captureArgs], injector: ["clang++", ...injectorArgs] },
  keepDebug: process.env.POC_KEEP_DEBUG === "1",
  outputs: await Promise.all([captureLibraryPath, injectorPath].map(async path => ({ path, sha256: await sha256(path) }))),
};
await writeFile(paths.nativeBuildManifestPath, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Recorded native build inputs in ${paths.nativeBuildManifestPath}`);
