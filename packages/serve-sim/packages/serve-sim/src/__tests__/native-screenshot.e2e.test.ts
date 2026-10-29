import { describe, expect, test } from "bun:test";
import { NativeCapture } from "../native";
import { DEFAULT_STREAM_ENCODER_SETTINGS } from "../stream-settings";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const udid = e2eDevice();
requireE2E("native-screenshot", Boolean(udid));

function dimensions(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe.skipIf(!udid)("native full-resolution screenshots", () => {
  test("concurrent screenshots keep native resolution without viewers and ignore the video cap", async () => {
    const capture = new NativeCapture(udid!, {
      ...DEFAULT_STREAM_ENCODER_SETTINGS,
      maxDimension: 320,
    });
    try {
      await capture.start();
      const display = await capture.activeScreenId();
      const screen = await capture.screenSize();
      const screenshots = await Promise.all(
        Array.from({ length: 8 }, () => capture.screenshot(display)),
      );
      for (const png of screenshots) {
        const size = dimensions(png);
        expect(Math.max(size.width, size.height)).toBe(Math.max(screen.width, screen.height));
        expect(Math.min(size.width, size.height)).toBe(Math.min(screen.width, screen.height));
        expect(Math.max(size.width, size.height)).toBeGreaterThan(320);
      }
      await expect(capture.screenshot(0)).rejects.toThrow();
      await expect(capture.screenshot(0x1_0000_0000)).rejects.toThrow();
    } finally {
      await capture.stop();
    }
  }, 45_000);

  test("suspension and shutdown cannot return old pixels, and resume can capture again", async () => {
    const capture = new NativeCapture(udid!);
    try {
      await capture.start();
      const display = await capture.activeScreenId();
      dimensions(await capture.screenshot(display));
      await capture.suspendForReboot();
      await expect(capture.screenshot(display)).rejects.toThrow();
      await capture.resumeAfterReboot();
      dimensions(await capture.screenshot(await capture.activeScreenId()));
    } finally {
      await capture.stop();
    }
    await expect(capture.screenshot(1)).rejects.toThrow();
  }, 45_000);
});
