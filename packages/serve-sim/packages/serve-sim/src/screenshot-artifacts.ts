import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export type ScreenshotArtifactResult =
  | { status: "disabled" }
  | { status: "saved"; file: string }
  | { status: "failed"; file: string; error: string };

export type ScreenshotOutcome = ScreenshotArtifactResult | { status: "capture-failed"; error: string };

// The filename format and the "could not save screenshot artifact" log text are a contract with
// the EAS worker in the eas-cli repository, packages/build-tools/src/steps/utils/deviceRunSessionScreenshots.ts:
// it matches filenames with a regex and surfaces that log line from the host output. The serve-sim and
// serve-emu copies are intentionally identical because @expo/serve-sim ships standalone with no workspace dependencies.
export async function saveScreenshotArtifact(
  png: Uint8Array,
  directory = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY,
): Promise<ScreenshotArtifactResult> {
  if (!directory) {
    return { status: "disabled" };
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueSuffix = randomBytes(6).toString("hex");
  const destination = join(directory, `screenshot-${timestamp}-${uniqueSuffix}.png`);
  const temporary = `${destination}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, png, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    return { status: "saved", file: destination };
  } catch (error) {
    console.error(`serve-sim: could not save screenshot artifact ${destination}:`, error);
    await rm(temporary, { force: true }).catch(() => {});
    return {
      status: "failed",
      file: destination,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
