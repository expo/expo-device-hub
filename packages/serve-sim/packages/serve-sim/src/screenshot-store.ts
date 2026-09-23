import { readdir, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";

import {
  type HostActionResult,
  createSerialQueue,
  ensurePrivateDirAsync,
  ok,
  pruneStaleEntriesAsync,
  runInvocation,
} from "./host-actions-utils";
import { DESKTOP_DIR, SCREENSHOT_DIR } from "./host-paths";

const MAX_STAGED_SCREENSHOTS = 200;
const SCREENSHOT_PREFIX = "serve-sim-screenshot-";
/** Staged copies are a cache; the one the operator keeps is on the Desktop. */
const MAX_SCREENSHOT_AGE_MS = 6 * 60 * 60 * 1000;
// A local copy takes milliseconds; a hung one should not hold the caller for the full action budget.
const DESKTOP_COPY_TIMEOUT_MS = 5_000;
// Not MAX_STAGED_SCREENSHOTS: staging is pruned, the Desktop keeps everything.
const MAX_DESKTOP_COPIES_PER_RUN = 200;
// Same race as uploads: the staged count is read, then simctl writes.
const queueScreenshotAsync = createSerialQueue();
// In memory: counting the Desktop means listing it, which this process never does.
let desktopCopiesMade = 0;

/**
 * Only names the ceiling above counts. Any other name would both slip the ceiling and let a link
 * holder replace an arbitrary file on the operator's Desktop, since simctl overwrites silently.
 */
export const ScreenshotName = z
  .string()
  .regex(
    new RegExp(`^${SCREENSHOT_PREFIX}[A-Za-z0-9._-]{1,100}\\.png$`),
    "must be a serve-sim screenshot name",
  );

async function stagedScreenshotBudgetExceededAsync(): Promise<boolean> {
  try {
    const entries = await readdir(SCREENSHOT_DIR);
    return entries.filter((e) => e.startsWith(SCREENSHOT_PREFIX)).length >= MAX_STAGED_SCREENSHOTS;
  } catch {
    return false;
  }
}

async function isEmptyFileAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size === 0;
  } catch {
    return false;
  }
}

export async function captureScreenshotAsync(p: {
  udid: string;
  fileName: string;
}): Promise<HostActionResult> {
  const hours = MAX_SCREENSHOT_AGE_MS / 3_600_000;
  const staged = join(SCREENSHOT_DIR, p.fileName);
  // Only the count and the reservation are serialized: holding the queue across simctl would let one
  // wedged capture stall everybody else's.
  const reserved = await queueScreenshotAsync(async () => {
    await ensurePrivateDirAsync(SCREENSHOT_DIR);
    await pruneStaleEntriesAsync(SCREENSHOT_DIR, MAX_SCREENSHOT_AGE_MS);
    if (await stagedScreenshotBudgetExceededAsync()) return false;
    // The empty file is the reservation, counted before simctl writes. "wx" so a same-named capture
    // that already produced a screenshot is not truncated; that name is already counted.
    try {
      await writeFile(staged, "", { flag: "wx" });
    } catch {
      return true;
    }
    return true;
  });
  if (!reserved) {
    return {
      stdout: "",
      stderr:
        `The screenshot was not taken: ${MAX_STAGED_SCREENSHOTS} screenshots are already ` +
        "staged, which is the most this preview keeps. Staged copies are removed after " +
        `${hours} hours; take another once the oldest have gone, or delete files from ` +
        `${SCREENSHOT_DIR} to make room now.`,
      exitCode: 1,
    };
  }
  const shot = await runInvocation({
    file: "xcrun",
    args: ["simctl", "io", p.udid, "screenshot", staged],
  });
  // Or the reservation holds a ceiling slot until the prune. Only while still empty: a second capture
  // of the same name may have written a real screenshot there since.
  if (shot.exitCode !== 0) {
    if (await isEmptyFileAsync(staged)) await rm(staged, { force: true });
    return shot;
  }
  const kept = `stays staged at ${staged} for at least ${hours} hours`;
  if (desktopCopiesMade >= MAX_DESKTOP_COPIES_PER_RUN) {
    return {
      stdout: staged,
      stderr:
        `This preview has copied ${MAX_DESKTOP_COPIES_PER_RUN} screenshots to the Desktop, the ` +
        `most it copies in one run, so this one ${kept}; restart the preview to copy there again.`,
      exitCode: 0,
    };
  }
  // The operator expects the file on the Desktop, but that is TCC-protected, so a child does
  // the copy: a consent prompt then blocks the child, which the deadline reaps.
  const copied = await runInvocation({
    file: "cp",
    args: [staged, join(DESKTOP_DIR, p.fileName)],
    timeoutMs: DESKTOP_COPY_TIMEOUT_MS,
  });
  if (copied.exitCode === 0) {
    desktopCopiesMade += 1;
    return ok(staged);
  }
  if (copied.timedOut) {
    return {
      stdout: staged,
      stderr:
        `The Desktop copy did not finish within ${DESKTOP_COPY_TIMEOUT_MS / 1000}s and was ` +
        "stopped, which usually means a Desktop access prompt is waiting for an answer on this " +
        `Mac, so the screenshot ${kept}.`,
      exitCode: 0,
    };
  }
  const reason = copied.stderr.trim() || `cp exited with code ${copied.exitCode}`;
  return {
    stdout: staged,
    stderr:
      `This host refused the Desktop copy (${reason}), which usually means Desktop access is ` +
      `denied for the process running this preview, so the screenshot ${kept}.`,
    exitCode: 0,
  };
}
