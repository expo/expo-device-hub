// Fails a publish that lacks a prebuilt agent. The release builds the agents on EAS (macOS and
// Linux jobs) and restores them from the Turborepo cache; a cache miss must not publish a package
// without them.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateFfmpegSourceArchive } from "./ffmpeg-source.mjs";

const required = [
  "dist/darwin-arm64/libexpo_emulator_capture.dylib",
  "dist/linux-x64/libexpo_emulator_capture.so",
  "dist/linux-x64/libexpo_emulator_capture_nvidia.so",
  "dist/linux-x64/ffmpeg-source.tar.xz",
];
const missing = required.filter(
  (path) => !existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url))),
);
if (missing.length > 0) {
  console.error(`[expo-emulator-capture] missing release artifact: ${missing.join(", ")}`);
  process.exit(1);
}
validateFfmpegSourceArchive(
  fileURLToPath(new URL("../dist/linux-x64/ffmpeg-source.tar.xz", import.meta.url)),
);
