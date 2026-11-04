import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { unlessDarwinArm64 } from "./platform.mjs";

unlessDarwinArm64("build:native");

if (!existsSync(join(root, "deps/frida-gum/libfrida-gum.a")))
  throw new Error("Frida Gum devkit missing; run bun run setup:build first");
await mkdir(join(root, "build"), { recursive: true });
await mkdir(join(root, "dist/darwin-arm64"), { recursive: true });

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
  "-Wall",
  "-Wextra",
  "-Wno-unused-parameter",
  "-fvisibility=hidden",
  "-shared",
  "-fPIC",
  "-arch",
  "arm64",
  "-mmacosx-version-min=13.0",
  "-I",
  "deps/frida-gum",
  "src/native/agent.mm",
  "src/native/encoder.mm",
  "src/native/frame-source.mm",
  "src/native/gfxstream.mm",
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
