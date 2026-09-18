import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Keep this module usable by Node as well as Bun, including the source archive
// scripts. All relative overrides are relative to the package, never the shell.
export function getBuildPaths(env = process.env) {
  function path(name, fallback) {
    if (env[name] !== undefined && (!env[name] || !env[name].trim()))
      throw new Error(`${name} must be a nonempty path`);
    return resolve(root, env[name] ?? fallback);
  }

  const buildDirectory = path("POC_BUILD_DIR", "build");
  const dependencyPrefixDirectory = join(buildDirectory, "deps");
  return {
    root,
    buildDirectory,
    outputDirectory: path("POC_DIST_DIR", "dist/linux-x64"),
    ffmpegSourceDirectory: path("POC_FFMPEG_SOURCE_DIR", "ffmpeg-source"),
    ffmpegBuildDirectory: path("POC_FFMPEG_BUILD_DIR", join(buildDirectory, "ffmpeg")),
    codecHeadersDirectory: path("POC_NV_CODEC_HEADERS_SOURCE_DIR", "nv-codec-headers"),
    gumDevkitDirectory: path("POC_FRIDA_GUM_DEVKIT_DIR", "deps/frida-gum"),
    coreDevkitDirectory: path("POC_FRIDA_CORE_DEVKIT_DIR", "deps/frida-core"),
    nvrtcLibraryPath: path("POC_NVRTC_LIBRARY", "deps/nvrtc/lib/libnvrtc.so.12"),
    dependencyPrefixDirectory,
    pkgConfigDirectory: join(dependencyPrefixDirectory, "lib/pkgconfig"),
    kernelHeaderPath: join(buildDirectory, "scale-ptx.h"),
    nativeBuildManifestPath: join(buildDirectory, "native-build.json"),
  };
}

export const paths = getBuildPaths();

export function requireFiles(directory, files, label) {
  for (const file of files) {
    const path = resolve(directory, file);
    if (!statSync(path, { throwIfNoEntry: false })?.isFile())
      throw new Error(`${label}: missing file ${path}. Supplied dependency directories are never downloaded or replaced.`);
  }
}

export function requireSourceDevkits(env = process.env) {
  if (env.POC_SOURCE_BUILD !== "1") return;
  for (const name of ["POC_FRIDA_GUM_DEVKIT_DIR", "POC_FRIDA_CORE_DEVKIT_DIR"])
    if (!env[name]) throw new Error(`POC_SOURCE_BUILD=1 requires ${name} pointing to a devkit rebuilt from source`);
}
