import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

// The filename format must change together with the consumer regex in the eas-cli repository at
// packages/build-tools/src/steps/utils/deviceRunSessionScreenshots.ts. The serve-sim and serve-emu
// copies are intentionally identical because @expo/serve-sim ships standalone with no workspace dependencies.
export async function saveScreenshotArtifact(
  png: Uint8Array,
  directory = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY,
): Promise<void> {
  if (!directory) {
    return;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueSuffix = randomBytes(6).toString("hex");
  const destination = join(directory, `screenshot-${timestamp}-${uniqueSuffix}.png`);
  const temporary = `${destination}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, png, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    console.error(`serve-emu: could not save screenshot artifact ${destination}:`, error);
    await rm(temporary, { force: true }).catch(() => {});
  }
}
