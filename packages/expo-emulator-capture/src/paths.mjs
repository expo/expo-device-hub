import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_LIBRARIES = {
  darwin: "darwin-arm64/libexpo_emulator_capture.dylib",
};

/** The agent library that `launch` preloads into the emulator on this platform. */
export function agentLibraryPath(platform = process.platform) {
  const library = AGENT_LIBRARIES[platform] ?? AGENT_LIBRARIES.darwin;
  return fileURLToPath(new URL(`../dist/${library}`, import.meta.url));
}

/** The environment variable that preloads a library on this platform. */
export function preloadVariable(platform = process.platform) {
  return platform === "linux" ? "LD_PRELOAD" : "DYLD_INSERT_LIBRARIES";
}

/** Where `launch` puts an emulator's capture socket by default, by adb serial. */
export function defaultSocketPath(serial, directory = join(tmpdir(), "expo-emulator-capture")) {
  return join(directory, `${serial}.sock`);
}
