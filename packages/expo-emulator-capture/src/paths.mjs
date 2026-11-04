import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The agent dylib that `launch` preloads into the emulator. */
export function agentLibraryPath() {
  return fileURLToPath(
    new URL("../dist/darwin-arm64/libexpo_emulator_capture.dylib", import.meta.url),
  );
}

/** Where `launch` puts an emulator's capture socket by default, by adb serial. */
export function defaultSocketPath(serial, directory = join(tmpdir(), "expo-emulator-capture")) {
  return join(directory, `${serial}.sock`);
}
