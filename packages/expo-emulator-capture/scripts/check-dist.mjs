// Fails a publish that lacks a prebuilt agent. The release builds the agents on EAS (macOS and
// Linux jobs) and restores them from the Turborepo cache; a cache miss must not publish a package
// without them.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const required = [
  "dist/darwin-arm64/libexpo_emulator_capture.dylib",
  "dist/linux-x64/libexpo_emulator_capture.so",
];
const missing = required.filter(
  (path) => !existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url))),
);
if (missing.length > 0) {
  console.error(`[expo-emulator-capture] missing prebuilt agent: ${missing.join(", ")}`);
  process.exit(1);
}
