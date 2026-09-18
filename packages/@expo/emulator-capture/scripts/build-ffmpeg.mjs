import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { $ } from "./common.mjs";
import { paths, requireFiles } from "./build-paths.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("build:ffmpeg");

const buildJobs = process.env.POC_BUILD_JOBS || "4";
if (!/^[1-9][0-9]*$/.test(buildJobs) || Number(buildJobs) > 128)
  throw new Error("POC_BUILD_JOBS must be an integer from 1 to 128");

const { ffmpegSourceDirectory, ffmpegBuildDirectory, codecHeadersDirectory, dependencyPrefixDirectory, pkgConfigDirectory } = paths;
requireFiles(ffmpegSourceDirectory, ["configure", "libavcodec/avcodec.h"], "FFmpeg source");
requireFiles(codecHeadersDirectory, ["ffnvcodec.pc.in", "include/ffnvcodec/nvEncodeAPI.h"], "NVIDIA codec headers");
if (ffmpegSourceDirectory !== ffmpegBuildDirectory && existsSync(join(ffmpegSourceDirectory, "ffbuild/config.mak")))
  throw new Error(`FFmpeg source ${ffmpegSourceDirectory} has an in-tree configuration. Use a fresh source directory, run make distclean there yourself, or explicitly set POC_FFMPEG_BUILD_DIR to the same directory. Sources were not changed.`);
await mkdir(ffmpegBuildDirectory, { recursive: true });

// Objects from another source checkout may be newer than replacement files.
// Clean generated objects after reconfiguration when source paths change.
const buildInputsPath = join(ffmpegBuildDirectory, "expo-build-inputs.json");
let changedSourcePaths = existsSync(join(ffmpegBuildDirectory, "ffbuild/config.mak"));
if (existsSync(buildInputsPath)) {
  const previous = JSON.parse(await readFile(buildInputsPath, "utf8"));
  changedSourcePaths = previous.ffmpegSourceDirectory !== ffmpegSourceDirectory || previous.codecHeadersDirectory !== codecHeadersDirectory;
}

// Upstream `make install` first writes ffnvcodec.pc into its source tree. Install
// the header-only dependency directly so a rebuild leaves supplied sources
// unchanged, even when switching between different object directories.
if (/[\r\n\\"'$#:]/.test(dependencyPrefixDirectory))
  throw new Error("POC_BUILD_DIR contains characters unsupported in pkg-config paths (quotes, backslashes, $, #, colon or newlines)");
const codecHeaderSource = join(codecHeadersDirectory, "include/ffnvcodec");
const installedHeaders = join(dependencyPrefixDirectory, "include/ffnvcodec");
const pkgConfigPath = join(pkgConfigDirectory, "ffnvcodec.pc");
const canonicalSource = await realpath(codecHeadersDirectory);
// Resolve existing parents too, so a symlinked output directory cannot point
// the installation or cleanup back into a caller's source checkout.
for (const output of [installedHeaders, pkgConfigPath]) {
  let existing = output;
  while (!existsSync(existing)) existing = dirname(existing);
  const canonicalOutput = resolve(await realpath(existing), relative(existing, output));
  const fromSource = relative(canonicalSource, canonicalOutput);
  if (!fromSource || (fromSource !== ".." && !fromSource.startsWith("../") && !isAbsolute(fromSource)))
    throw new Error("POC_BUILD_DIR must place installed NVIDIA headers outside POC_NV_CODEC_HEADERS_SOURCE_DIR");
}
const headerNames = (await readdir(codecHeaderSource)).filter(name => name.endsWith(".h"));
const pkgConfigTemplate = await readFile(join(codecHeadersDirectory, "ffnvcodec.pc.in"), "utf8");
if (!pkgConfigTemplate.includes("@@PREFIX@@"))
  throw new Error("NVIDIA codec header ffnvcodec.pc.in must contain the @@PREFIX@@ installation placeholder");
// This is an owned output directory. Clear obsolete headers when changing the
// dependency version instead of accidentally retaining headers from a prior one.
await rm(installedHeaders, { recursive: true, force: true });
await mkdir(installedHeaders, { recursive: true });
await mkdir(pkgConfigDirectory, { recursive: true });
for (const name of headerNames) await copyFile(join(codecHeaderSource, name), join(installedHeaders, name));
const pkgConfig = pkgConfigTemplate.replaceAll("@@PREFIX@@", dependencyPrefixDirectory)
  .replaceAll("-I${includedir}", '-I"${includedir}"');
await writeFile(pkgConfigPath, pkgConfig);
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
const configureEnvironment = {
  ...process.env,
  PKG_CONFIG_PATH: [pkgConfigDirectory, process.env.PKG_CONFIG_PATH].filter(Boolean).join(":"),
};
// Always run make so edits to ffmpeg-source are compiled even when archives exist.
await $`${join(ffmpegSourceDirectory, "configure")} ${configureFlags}`.cwd(ffmpegBuildDirectory).env(configureEnvironment);
if (changedSourcePaths) await $`make clean`.cwd(ffmpegBuildDirectory);
await $`make -j${buildJobs}`.cwd(ffmpegBuildDirectory);
await writeFile(buildInputsPath, `${JSON.stringify({ ffmpegSourceDirectory, codecHeadersDirectory, configureFlags }, null, 2)}\n`);
