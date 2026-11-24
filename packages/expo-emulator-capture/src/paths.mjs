import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_LIBRARIES = {
  darwin: "darwin-arm64/libexpo_emulator_capture.dylib",
  linux: "linux-x64/libexpo_emulator_capture.so",
};

/** The agent library that `launch` preloads into the emulator on this platform. */
export function agentLibraryPath(platform = process.platform, env = process.env) {
  const backend = env.EXPO_EMULATOR_CAPTURE_BACKEND?.trim();
  if (backend && backend !== "nvidia")
    throw new Error("EXPO_EMULATOR_CAPTURE_BACKEND must be nvidia or unset");
  if (backend === "nvidia" && platform !== "linux")
    throw new Error("NVIDIA capture requires Linux x86-64");
  const library =
    backend === "nvidia"
      ? "linux-x64/libexpo_emulator_capture_nvidia.so"
      : (AGENT_LIBRARIES[platform] ?? AGENT_LIBRARIES.darwin);
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
