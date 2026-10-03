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

async function pasteboardChangeCount(udid: string): Promise<number> {
  const tool = locatePasteboardTool() ?? buildSimpbArtifact("SimPasteboard", "serve-sim-pasteboard");
  const output = await simctl(["spawn", udid, tool, "--change-count"], 3_000);
  if (!/^\d+$/.test(output)) throw new Error("Invalid simulator pasteboard change count");
  const count = Number(output);
  if (!Number.isSafeInteger(count)) throw new Error("Invalid simulator pasteboard change count");
  return count;
}

async function pasteboardAppTool(udid: string): Promise<string> {
  const app = locateSimpbArtifact("ServeSimPasteboard.app") ??
    buildSimpbArtifact("SimPasteboard", "ServeSimPasteboard.app");
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
 */
export function copyFromSim(
  udid: string,
  sendCopyShortcut: () => Promise<void>,
): Promise<PasteboardReadResult> {
  return withSimPasteboardLock(udid, async () => {
    const appTool = await pasteboardAppTool(udid);
    // Native apps may write concurrently. Copy does not mutate the shared pasteboard itself.
    const before = await pasteboardChangeCount(udid);
    await sendCopyShortcut();
    await waitForPasteboardChange(() => pasteboardChangeCount(udid), before);
    const text = await readPasteboardText(["spawn", udid, appTool, "--read-text"], { timeout: 8_000 });
    return { text, relaunchedApp: null };
  });
}
