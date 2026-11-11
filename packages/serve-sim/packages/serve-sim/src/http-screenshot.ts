import { randomBytes } from "crypto";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { peekDeviceSession, withScreenshotDeviceSession } from "./device-session";
import { convertScreenshot } from "./native";
import {
  getScreenshotDisplayIdsAsync,
  getSoleScreenshotDisplayIdAsync,
} from "./screenshot-display";
import {
  captureNativeScreenshotAsync,
  captureScreenshotFileAsync,
  SCREENSHOT_DISPLAY_CHANGED,
} from "./screenshot-store";
import type { StreamSettings } from "./stream-settings";

/** PNG for /api/screenshot, at most maxWidth wide. HTTP downloads avoid staging and
 * Desktop copies, but share panel election. */
export async function captureScreenshotPngAsync(p: {
  udid: string;
  display: number | undefined;
  maxWidth: number | undefined;
  settings: StreamSettings | undefined;
  isBooted: () => Promise<boolean>;
}): Promise<{ png: Uint8Array; nativeMs: number }> {
  let file: string | undefined;
  let nativeMs = 0;
  const capture = async (id: number) => {
    file ??= join(tmpdir(), `serve-sim-screenshot-${randomBytes(8).toString("hex")}.png`);
    const result = await captureScreenshotFileAsync({
      udid: p.udid,
      file,
      display: id,
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Simulator screenshot failed");
    const png = await readFile(file);
    return p.maxWidth ? await convertScreenshot(png, p.maxWidth) : png;
  };
  try {
    if (p.display !== undefined) return { png: await capture(p.display), nativeMs };
    // @ref LLP 0003#action-catalog -- a cold session with one verified display needs no native video
    const sole = peekDeviceSession(p.udid) ? null : await getSoleScreenshotDisplayIdAsync(p.udid);
    // A viewer can start a session while the probes run; recheck with no await before simctl starts.
    if (sole !== null && !peekDeviceSession(p.udid)) return { png: await capture(sole), nativeMs };
    const png = await withScreenshotDeviceSession(p.udid, p.settings, async (session) => {
      const read = () => session.activeScreenId();
      return Buffer.from(
        await captureNativeScreenshotAsync(
          await read(),
          read,
          async (id, timeoutMs) => {
            const started = performance.now();
            try {
              return await session.screenshot(id, timeoutMs, p.maxWidth);
            } finally {
              nativeMs += performance.now() - started;
            }
          },
          5_000,
        ),
      );
    }).catch(async (error) => {
      if (error instanceof Error && error.message === SCREENSHOT_DISPLAY_CHANGED) throw error;
      // A sole integrated display needs no native panel election. Never
      // fall back on an unknown profile or a multi-display device.
      if (!(await p.isBooted())) throw error;
      const ids = await getScreenshotDisplayIdsAsync(p.udid);
      if (ids?.length !== 1) throw error;
      return await capture(ids[0]!);
    });
    return { png, nativeMs };
  } finally {
    // Best-effort cleanup; the PNG is already in memory by now.
    if (file) await unlink(file).catch(() => {});
  }
}
