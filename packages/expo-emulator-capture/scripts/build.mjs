import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { requireNativeTarget } from "./platform.mjs";

const target = requireNativeTarget("build:native");

if (!existsSync(join(root, "deps/frida-gum/libfrida-gum.a")))
  throw new Error("Frida Gum devkit missing; run bun run setup:build first");
await mkdir(join(root, "build"), { recursive: true });
await mkdir(join(root, `dist/${target}`), { recursive: true });

const warnings = ["-Wall", "-Wextra", "-Wno-unused-parameter"];
// Hello and expo_emulator_capture_version() report the package version.
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`unexpected package version ${version}`);
const defines = [`-DEXPO_EMULATOR_CAPTURE_VERSION="${version}"`];

if (target === "darwin-arm64") {
  // Export one version symbol; everything else, including the bundled Gum and
  // GLib, stays private to the agent so it cannot clash with the emulator's GLib.
  const exportsPath = join(root, "build/exports.txt");
  await writeFile(exportsPath, "_expo_emulator_capture_version\n");

  const library = "dist/darwin-arm64/libexpo_emulator_capture.dylib";
  const args = [
    "-std=c++17",
    "-fobjc-arc",
    "-O2",
    "-g",
    ...warnings,
    "-fvisibility=hidden",
    "-shared",
    "-fPIC",
    "-arch",
    "arm64",
    "-mmacosx-version-min=13.0",
    ...defines,
    "-I",
    "deps/frida-gum",
    "src/native/agent.cpp",
    "src/native/encoder-videotoolbox.mm",
    "src/native/frame-source-darwin.mm",
    "src/native/gfxstream.cpp",
    "-o",
    library,
    "deps/frida-gum/libfrida-gum.a",
    `-Wl,-exported_symbols_list,${exportsPath}`,
    "-Wl,-dead_strip",
    "-lresolv",
    ...[
      "Accelerate",
      "CoreFoundation",
      "CoreMedia",
      "CoreVideo",
      "Foundation",
      "IOSurface",
      "OpenGL",
      "VideoToolbox",
    ].flatMap((framework) => ["-framework", framework]),
  ];
  await $`clang++ ${args}`;

  // Keep release artifacts small, with an opt-out for native debugging. The
  // linker's ad-hoc signature is replaced after stripping.
  if (process.env.EXPO_EMULATOR_CAPTURE_KEEP_DEBUG !== "1") {
    await $`strip -x ${library}`;
    await $`codesign --force --sign - ${library}`;
  }
} else {
  // CXX may carry arguments, such as "ccache g++".
  const [compiler, ...compilerArgs] = (process.env.CXX || "g++").trim().split(/\s+/);
  // @ref LLP 0021#encoder — x264 build 165 from the host, not bundled
  // The agent includes x264's header from the build host (libx264-dev) and loads the
  // library at run time, so the header must be build 165, the build that the agent loads.
  const probe = await $`${compiler} ${compilerArgs} -E -P -x c++ - < ${new Response(
    "#include <stdint.h>\n#include <x264.h>\nx264_build_is X264_BUILD\n",
  )}`
    .quiet()
    .nothrow();
  const build = /x264_build_is (\d+)/.exec(probe.stdout.toString())?.[1];
  if (build !== "165") {
    const stderr = probe.stderr.toString().trim();
    throw new Error(
      build
        ? `x264.h is build ${build}; the agent needs build 165 (Ubuntu 26.04: sudo apt install libx264-dev)`
        : probe.exitCode !== 0 && !stderr.includes("x264.h")
          ? `the x264 header check failed: ${stderr.split("\n").slice(-3).join(" ")}`
          : "x264.h is missing; install x264 build 165 headers (Ubuntu 26.04: sudo apt install libx264-dev)",
    );
  }

  // The same single export. --exclude-libs keeps the bundled Gum, GLib and the
  // static C++ library private: a preloaded library's exports would otherwise
  // take precedence over the emulator's own symbols.
  const versionScript = join(root, "build/exports.map");
  await writeFile(versionScript, "{ global: expo_emulator_capture_version; local: *; };\n");

  const library = "dist/linux-x64/libexpo_emulator_capture.so";
  const args = [
    "-std=c++17",
    "-O2",
    "-g",
    ...warnings,
    "-fvisibility=hidden",
    "-shared",
    "-fPIC",
    ...defines,
    "-I",
    "deps/frida-gum",
    "src/native/agent.cpp",
    "src/native/encoder-x264.cpp",
    "src/native/frame-source-linux.cpp",
    "src/native/pbo-borrow.cpp",
    "src/native/gfxstream.cpp",
    "-o",
    library,
    "deps/frida-gum/libfrida-gum.a",
    `-Wl,--version-script=${versionScript}`,
    "-Wl,--exclude-libs,ALL",
    "-Wl,--gc-sections",
    "-static-libstdc++",
    "-static-libgcc",
    "-pthread",
    "-ldl",
    "-lm",
    "-lrt",
    "-lresolv",
  ];
  // @ref LLP 0021#c-runtime — any C++ library works; only findColorBuffer's result is a libc++ object
  await $`${compiler} ${compilerArgs} ${args}`;
  // GNU strip -x keeps the debug sections; --strip-unneeded removes them and the local symbols,
  // and keeps the dynamic export.
  if (process.env.EXPO_EMULATOR_CAPTURE_KEEP_DEBUG !== "1")
    await $`strip --strip-unneeded ${library}`;
}
