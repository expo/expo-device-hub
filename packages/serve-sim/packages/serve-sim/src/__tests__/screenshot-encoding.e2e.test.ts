import { describe, expect, test } from "bun:test";
import { convertScreenshot, locateNativeAddon } from "../native";
import { requireE2E } from "./e2e-preconditions";

const available = Boolean(locateNativeAddon());
requireE2E("screenshot-encoding", available);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!available)("native screenshot conversion binding", () => {
  test("omitted JPEG quality preserves PNG, including sliced input buffers", async () => {
    const backing = Buffer.concat([Buffer.alloc(17), png, Buffer.alloc(19)]);
    const result = Buffer.from(await convertScreenshot(backing.subarray(17, 17 + png.length), 402));
    expect(result.subarray(0, 8)).toEqual(png.subarray(0, 8));
    expect(result.readUInt32BE(16)).toBe(1);
    expect(result.readUInt32BE(20)).toBe(1);
  });

  test("explicit JPEG quality returns JPEG and invalid image bytes fail", async () => {
    const jpeg = await convertScreenshot(png, 402, 80);
    expect([...jpeg.subarray(0, 3)]).toEqual([255, 216, 255]);
    await expect(convertScreenshot(Buffer.from("invalid"), 402)).rejects.toThrow();
  });
});
