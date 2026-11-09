import { expect, test } from "bun:test";
import { screenshotResponse } from "../src/screenshot-response.ts";

// An allowed cross-origin caller can read a custom header only when the response lists it, as serve-sim's does.
test("lets a cross-origin caller read the screenshot artifact headers", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

  for (const url of [
    "http://router.test/api/screenshot",
    "http://router.test/api/screenshot?format=base64",
  ]) {
    const response = await screenshotResponse(async () => png, new URL(url));
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Expo-Screenshot-Artifact, X-Expo-Screenshot-Artifact-Error, Server-Timing",
    );
  }
});

test("rejects invalid image options before capturing or publishing an artifact", async () => {
  let captures = 0;
  for (const query of [
    "maxWidth=0",
    "maxWidth=1.5",
    "maxWidth=8193",
    "format=gif",
    "quality=101",
  ]) {
    const response = await screenshotResponse(
      async () => {
        captures++;
        return new Uint8Array();
      },
      new URL(`http://router.test/api/screenshot?${query}`),
    );
    expect(response.status).toBe(400);
  }
  expect(captures).toBe(0);
});

test("resizes portrait and landscape PNG/JPEG without upscaling or transparent edges", async () => {
  const { default: sharp } = await import("sharp");
  for (const [width, height, limit, outputWidth, outputHeight] of [
    [120, 260, 40, 40, 87],
    [260, 120, 40, 40, 18],
    [17, 31, 40, 17, 31],
    [17, 31, 1, 1, 2],
  ]) {
    const png = await sharp({ create: { width, height, channels: 4, background: "black" } })
      .png()
      .toBuffer();
    for (const format of ["png", "jpeg"]) {
      const response = await screenshotResponse(
        async () => png,
        new URL(`http://router.test/api/screenshot?maxWidth=${limit}&format=${format}&quality=80`),
      );
      expect(response.headers.get("content-type")).toBe(`image/${format}`);
      const output = Buffer.from(await response.arrayBuffer());
      expect(Number(response.headers.get("content-length"))).toBe(output.length);
      const metadata = await sharp(output).metadata();
      expect([metadata.width, metadata.height]).toEqual([outputWidth, outputHeight]);
      const { data, info } = await sharp(output)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      for (let i = 0; i < data.length; i += 4) {
        expect(data[i]).toBeLessThanOrEqual(2);
        expect(data[i + 3]).toBe(255);
      }
    }
  }
});

test("preserves native PNG bytes and the legacy base64 PNG response", async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const plain = await screenshotResponse(
    async () => png,
    new URL("http://router.test/api/screenshot"),
  );
  expect(new Uint8Array(await plain.arrayBuffer())).toEqual(png);
  const base64 = await screenshotResponse(
    async () => png,
    new URL("http://router.test/api/screenshot?format=base64"),
  );
  expect((await base64.json()).data).toBe(Buffer.from(png).toString("base64"));
  expect(plain.headers.get("server-timing")).toMatch(
    /total;dur=[\d.]+, capture;dur=[\d.]+, encode;dur=[\d.]+, artifact;dur=[\d.]+/,
  );
});

test("JPEG returns a resized PNG artifact and failed conversion publishes nothing", async () => {
  const { default: sharp } = await import("sharp");
  const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "serve-emu-image-"));
  const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
  process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = directory;
  try {
    const url = new URL("http://router.test/api/screenshot?maxWidth=40&format=jpeg");
    await expect(screenshotResponse(async () => Buffer.from("bad image"), url)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    const png = await sharp({
      create: { width: 120, height: 260, channels: 4, background: "black" },
    })
      .png()
      .toBuffer();
    const response = await screenshotResponse(async () => png, url);
    expect(response.headers.get("x-expo-screenshot-artifact")).toBe("saved");
    const [file] = await readdir(directory);
    const metadata = await sharp(await readFile(join(directory, file!))).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual(["png", 40, 87]);
  } finally {
    if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
    else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
