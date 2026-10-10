import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { simctl } from "./simctl";
import { buildSimpbArtifact, locatePasteboardTool, locateSimpbArtifact, readPasteboardText, withSimPasteboardLock, type PasteboardReadResult } from "./sim-pasteboard";

const COPY_CHANGE_TIMEOUT_MS = 5_000;
const COPY_CHANGE_POLL_MS = 75;
const PASTEBOARD_APP_BUNDLE = "com.expo.serve-sim-pasteboard";

export class PasteboardCopyTimeoutError extends Error {
  constructor() {
    super("The simulator app did not update the clipboard after Copy. Try again after selecting text.");
  }
}

/** Copy can fail after its chord left a key held. Keep that warning on the error for the viewer. */
export function withCleanupWarning(error: unknown, cleanupWarning: string | null): unknown {
  if (cleanupWarning && error instanceof Error) Object.assign(error, { cleanupWarning });
  return error;
}

export function cleanupWarningOf(error: unknown): { cleanupWarning?: string } {
  const cleanupWarning = error instanceof Error ? (error as { cleanupWarning?: unknown }).cleanupWarning : undefined;
  return typeof cleanupWarning === "string" ? { cleanupWarning } : {};
}

async function pasteboardChangeCount(udid: string): Promise<number> {
  const tool = locatePasteboardTool() ?? await buildSimpbArtifact("SimPasteboard", "serve-sim-pasteboard");
  const output = await simctl(["spawn", udid, tool, "--change-count"], 3_000);
  if (!/^\d+$/.test(output)) throw new Error("Invalid simulator pasteboard change count");
  const count = Number(output);
  if (!Number.isSafeInteger(count)) throw new Error("Invalid simulator pasteboard change count");
  return count;
}

async function pasteboardAppTool(udid: string): Promise<string> {
  const app = locateSimpbArtifact("ServeSimPasteboard.app") ??
    await buildSimpbArtifact("SimPasteboard", "ServeSimPasteboard.app");
  // Check the simulator rather than caching by UDID: an erase removes installed apps.
  const installed = await simctl(["get_app_container", udid, PASTEBOARD_APP_BUNDLE, "app"])
    .catch(() => null);
  if (!installed || installed === "(null)") await simctl(["install", udid, app]);
  await simctl(["privacy", udid, "grant", "pasteboard", PASTEBOARD_APP_BUNDLE]);
  return join(app, "serve-sim-pasteboard");
}

export async function waitForPasteboardChange(
  readCount: () => Promise<number>,
  baseline: number,
  timeoutMs = COPY_CHANGE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await readCount() !== baseline) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PasteboardCopyTimeoutError();
    await sleep(Math.min(COPY_CHANGE_POLL_MS, remaining));
  }
}

/**
 * Press Command+C and read only after the app changes the pasteboard. Paste and writes take the
 * same lock, so another viewer's copy or paste cannot replace the text before the read.
 * `inInputTurn` runs the copy in the device input queue. The input turn comes first and the lock
 * second, as for Paste, so the two cannot wait on each other.
 */
export async function copyFromSim(
  udid: string,
  sendCopyShortcut: () => Promise<void>,
  inInputTurn: (copy: () => Promise<string>) => Promise<string> = (copy) => copy(),
): Promise<PasteboardReadResult> {
  const appTool = await pasteboardAppTool(udid);
  const text = await inInputTurn(() => withSimPasteboardLock(udid, async () => {
    // Native apps may write concurrently. Copy does not mutate the shared pasteboard itself.
    // @ref LLP 0010#copy — why Copy waits for the first change and may time out on the same text
    const before = await pasteboardChangeCount(udid);
    await sendCopyShortcut();
    await waitForPasteboardChange(() => pasteboardChangeCount(udid), before);
    return readPasteboardText(["spawn", udid, appTool, "--read-text"], { timeout: 8_000 });
  }));
  return { text };
}
