import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenshotMetadata } from "../src/screenshot-metadata.ts";
import { screenshotResponse } from "../src/screenshot-response.ts";
import { parseScreenshotBase64Response } from "../src/shared/api-contracts.ts";

const fixture = new URL(
  "../../../../serve-sim/packages/serve-sim/Sources/SimPasteboard/Icons/AppIcon60x60@2x.png",
  import.meta.url,
);

test("both standalone servers use the same screenshot metadata contract", async () => {
  const sim = new URL(
    "../../../../serve-sim/packages/serve-sim/src/screenshot-metadata.ts",
    import.meta.url,
  );
  expect(await readFile(new URL("../src/screenshot-metadata.ts", import.meta.url), "utf8")).toBe(
    await readFile(sim, "utf8"),
  );
});

test("PNG and JSON responses return dimensions without publishing sidecars", async () => {
  const png = await readFile(fixture);
  const directory = await mkdtemp(join(tmpdir(), "screenshot-response-metadata-"));
  const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
  process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = directory;
  try {
    for (const format of ["", "?format=base64"]) {
      const response = await screenshotResponse(
        png,
        new URL(`http://router.test/api/screenshot${format}`),
      );
      expect(response.headers.get("X-Expo-Screenshot-Metadata")).toBe(
        JSON.stringify({ width: 120, height: 120 }),
      );
      expect(response.headers.get("access-control-expose-headers")).toContain(
        "X-Expo-Screenshot-Metadata",
      );
      if (format) {
        const body = parseScreenshotBase64Response(await response.json());
        expect(body.metadata).toEqual({ width: 120, height: 120 });
        expect(Buffer.from(body.data, "base64")).toEqual(png);
      } else {
        expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
      }
    }
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.endsWith(".png"))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
    else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown and corrupt IHDRs omit dimensions, and older JSON replies remain valid", async () => {
  const png = await readFile(fixture);
  expect(screenshotMetadata(png)).toEqual({ width: 120, height: 120 });
  expect(screenshotMetadata(png.subarray(0, 24))).toBeUndefined();
  const corrupt = Buffer.from(png);
  corrupt.writeUInt32BE(121, 16);
  expect(screenshotMetadata(corrupt)).toBeUndefined();
  const response = await screenshotResponse(corrupt, new URL("http://router.test/api/screenshot"));
  expect(response.headers.has("X-Expo-Screenshot-Metadata")).toBe(false);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(corrupt);
  expect(parseScreenshotBase64Response({ ok: true, mimeType: "image/png", data: "" })).toEqual({
    ok: true,
    mimeType: "image/png",
    data: "",
  });
});
