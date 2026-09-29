import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export type ScreenshotArtifactResult =
  | { status: "disabled" }
  | { status: "saved"; file: string }
  | { status: "failed"; file: string; error: string };

export type ScreenshotOutcome = ScreenshotArtifactResult | { status: "capture-failed"; error: string };

// The PNG filename pattern and the failure record (screenshot-<time>-<suffix>.failed.json holding
// { file, error, at }) are a contract with the EAS worker in the eas-cli repository,
// packages/build-tools/src/steps/utils/deviceRunSessionScreenshots.ts. serve-sim and serve-emu each
// carry a byte-identical copy of this file because @expo/serve-sim ships standalone with no workspace
// dependencies; serve-emu's screenshot-artifacts-sync test fails when the copies diverge.
export async function saveScreenshotArtifact(
  png: Uint8Array,
  directory = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY,
): Promise<ScreenshotArtifactResult> {
  if (!directory) {
    return { status: "disabled" };
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueSuffix = randomBytes(6).toString("hex");
  const name = `screenshot-${timestamp}-${uniqueSuffix}`;
  const destination = join(directory, `${name}.png`);
  const temporary = `${destination}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, png, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    return { status: "saved", file: destination };
  } catch (error) {
    console.error(`could not save screenshot artifact ${destination}:`, error);
    await rm(temporary, { force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    await writeFailureRecord(join(directory, `${name}.failed.json`), `${name}.png`, message);
    return { status: "failed", file: destination, error: message };
  }
}

async function writeFailureRecord(record: string, file: string, error: string): Promise<void> {
  const temporary = `${record}.tmp`;
  try {
    const content = JSON.stringify({ file, error, at: new Date().toISOString() });
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, record);
  } catch (recordError) {
    console.error(`could not write screenshot failure record ${record}:`, recordError);
    await rm(temporary, { force: true }).catch(() => {});
  }
}
