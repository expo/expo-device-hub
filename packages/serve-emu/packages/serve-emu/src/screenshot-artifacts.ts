import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export type ScreenshotArtifactResult =
  | { status: "disabled" }
  | { status: "saved"; file: string }
  | { status: "failed"; file: string; error: string };

// The failed `error` reaches the browser through the response and the preview UIs, so nothing from
// the error message is sent: only an errno code such as ENOSPC or EACCES, else a fixed text. The full
// message goes only to the stderr line and the failure record; the EAS worker reads that record and
// reports it in the job log and to Sentry, never to the browser.
export function clientSafeErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z]{2,}$/.test(code) ? code : "unknown error";
}

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
    return { status: "failed", file: destination, error: clientSafeErrorMessage(error) };
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

export const SCREENSHOT_ARTIFACT_HEADER = "X-Expo-Screenshot-Artifact";
export const SCREENSHOT_ARTIFACT_ERROR_HEADER = "X-Expo-Screenshot-Artifact-Error";
const MAX_ERROR_HEADER_LENGTH = 512;
// Anything outside printable ASCII (space through tilde) except whitespace; fs errors can hold any path.
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e\s]/g;
// Newlines and tabs are not allowed in a header value; collapse every whitespace run to one space.
const WHITESPACE_RUN = /\s+/g;

// The preview UIs read these to tell the user whether the capture they downloaded also reached the
// session artifacts.
export function screenshotArtifactHeaders(result: ScreenshotArtifactResult): Record<string, string> {
  if (result.status !== "failed") return { [SCREENSHOT_ARTIFACT_HEADER]: result.status };
  const error = result.error
    .replace(NOT_PRINTABLE_ASCII, "")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .slice(0, MAX_ERROR_HEADER_LENGTH);
  return { [SCREENSHOT_ARTIFACT_HEADER]: "failed", [SCREENSHOT_ARTIFACT_ERROR_HEADER]: error };
}
