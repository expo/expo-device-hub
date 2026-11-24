import { expect, spyOn, test } from "bun:test";
import { captureScreenshot, screenshotResponse } from "../src/screenshot-response.ts";

// An allowed cross-origin caller can read a custom header only when the response lists it, as serve-sim's does.
test("lets a cross-origin caller read the screenshot artifact headers", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

  for (const url of [
    "http://router.test/api/screenshot",
    "http://router.test/api/screenshot?format=base64",
  ]) {
    const response = await screenshotResponse(async () => ({ png }), new URL(url));
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Expo-Screenshot-Artifact, X-Expo-Screenshot-Artifact-Error, X-Expo-Screenshot-Metadata, Server-Timing",
    );
  }
});

test("returns the contract in PNG headers and existing JSON responses without changing pixels", async () => {
  const { parseScreenshotBase64Response } = await import("../src/shared/api-contracts.ts");
  const png = new Uint8Array([137, 80, 78, 71]);
  const metadata = {
    width: 0,
    height: 0,
    displayRotation: "landscape-left" as const,
  };
  const raw = await screenshotResponse(
    async () => ({ png, metadata }),
    new URL("http://router.test/api/screenshot"),
  );
  expect(JSON.parse(raw.headers.get("X-Expo-Screenshot-Metadata")!)).toEqual(metadata);
  expect(new Uint8Array(await raw.arrayBuffer())).toEqual(png);
  const json = await screenshotResponse(
    async () => ({ png, metadata }),
    new URL("http://router.test/api/screenshot?format=base64"),
  );
  const result = parseScreenshotBase64Response(await json.json());
  expect(result.metadata).toEqual(metadata);
  for (const screen of ["inner", "outer"] as const) {
    expect(
      parseScreenshotBase64Response({
        ok: true,
        mimeType: "image/png",
        data: "",
        metadata: { ...metadata, screen },
      }).metadata?.screen,
    ).toBe(screen);
  }
  expect(() =>
    parseScreenshotBase64Response({
      ok: true,
      mimeType: "image/png",
      data: "",
      metadata: { ...metadata, screen: 0 },
    }),
  ).toThrow();
  expect(Buffer.from(result.data, "base64")).toEqual(Buffer.from(png));
  expect(
    parseScreenshotBase64Response({ ok: true, mimeType: "image/png", data: "" }).metadata,
  ).toBeUndefined();
});

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function observedReader(readings: Array<ScreenOrientationValue | Error>) {
  const { createDisplayOrientationReader } = await import("../src/display-orientation.ts");
  let reads = 0;
  const instance = createDisplayOrientationReader({
    read: async () => {
      const next = readings[Math.min(reads++, readings.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { ...instance, reads: () => reads };
}

type ScreenOrientationValue = import("../src/shared/api-contracts.ts").ScreenOrientation;

test("capture reports the rotation observed before and after it, and the PNG size", async () => {
  const { reader, reads } = await observedReader(["landscape_left"]);
  const png = pngHeader(2400, 1080);
  const shot = await captureScreenshot(async () => png, reader);
  expect(shot.png).toBe(png);
  expect(shot.metadata).toEqual({ width: 2400, height: 1080, displayRotation: "landscape-left" });
  expect(reads()).toBe(2);
});

test("a turn during capture leaves the rotation unknown but keeps the size", async () => {
  const { reader } = await observedReader(["portrait", "landscape_left"]);
  const shot = await captureScreenshot(async () => pngHeader(2400, 1080), reader);
  expect(shot.metadata).toEqual({ width: 2400, height: 1080, displayRotation: null });
});

test("a Hub turn in flight during capture leaves the rotation unknown", async () => {
  // The display reads the same pose both times, so only the in-flight command can drop it.
  const { reader, locking, locked } = await observedReader(["portrait"]);
  const shot = await captureScreenshot(async () => {
    locking();
    return pngHeader(1080, 2400);
  }, reader);
  locked("portrait");
  expect(shot.metadata.displayRotation).toBeNull();
});

test("Hub turns that start and finish during capture leave the rotation unknown", async () => {
  const { reader, locking, locked } = await observedReader(["portrait"]);
  const shot = await captureScreenshot(async () => {
    locking();
    locked("portrait_upside_down");
    locking();
    locked("portrait");
    return pngHeader(1080, 2400);
  }, reader);
  expect(shot.metadata.displayRotation).toBeNull();
});

test("the first reading finishes before the frame is captured", async () => {
  const { createDisplayOrientationReader } = await import("../src/display-orientation.ts");
  let finished = 0;
  const { reader } = createDisplayOrientationReader({
    read: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished++;
      return "portrait";
    },
  });
  let finishedAtCapture = -1;
  const shot = await captureScreenshot(async () => {
    finishedAtCapture = finished;
    return pngHeader(1080, 2400);
  }, reader);
  expect(finishedAtCapture).toBe(1);
  expect(finished).toBe(2);
  expect(shot.metadata.displayRotation).toBe("portrait");
});

test("two readings of the same shape that disagree leave the rotation unknown", async () => {
  for (const [first, after, width, height] of [
    ["landscape_left", "landscape_right", 2400, 1080],
    ["portrait", "portrait_upside_down", 1080, 2400],
  ] as const) {
    const { reader } = await observedReader([first, after]);
    const shot = await captureScreenshot(async () => pngHeader(width, height), reader);
    expect(shot.metadata).toEqual({ width, height, displayRotation: null });
  }
});

test("a rotation whose shape disagrees with the image is dropped", async () => {
  const { reader } = await observedReader(["portrait"]);
  const shot = await captureScreenshot(async () => pngHeader(2400, 1080), reader);
  expect(shot.metadata.displayRotation).toBeNull();
});

test("a failed rotation read leaves the rotation unknown", async () => {
  const { reader } = await observedReader([new Error("offline")]);
  const shot = await captureScreenshot(async () => pngHeader(1080, 2400), reader);
  expect(shot.metadata).toEqual({ width: 1080, height: 2400, displayRotation: null });
});

test("bytes that are not a PNG keep the size unknown", async () => {
  const { reader } = await observedReader(["portrait"]);
  const shot = await captureScreenshot(async () => new Uint8Array([137, 80, 78, 71]), reader);
  expect(shot.metadata).toEqual({ width: 0, height: 0, displayRotation: "portrait" });
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
        return { png: new Uint8Array() };
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
        async () => ({ png }),
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
    async () => ({ png }),
    new URL("http://router.test/api/screenshot"),
  );
  expect(new Uint8Array(await plain.arrayBuffer())).toEqual(png);
  const base64 = await screenshotResponse(
    async () => ({ png }),
    new URL("http://router.test/api/screenshot?format=base64"),
  );
  expect((await base64.json()).data).toBe(Buffer.from(png).toString("base64"));
  expect(plain.headers.get("server-timing")).toMatch(
    /total;dur=[\d.]+, capture;dur=[\d.]+, encode;dur=[\d.]+, artifact;dur=[\d.]+/,
  );
});

test("resized images report their output dimensions and preserve observed rotation", async () => {
  const { default: sharp } = await import("sharp");
  for (const [width, height, pose] of [
    [120, 260, "portrait"],
    [260, 120, "landscape_left"],
  ] as const) {
    const png = await sharp({ create: { width, height, channels: 4, background: "black" } })
      .png()
      .toBuffer();
    for (const format of ["png", "jpeg", "base64"]) {
      const { reader } = await observedReader([pose]);
      const response = await screenshotResponse(
        () => captureScreenshot(async () => png, reader),
        new URL(`http://router.test/api/screenshot?maxWidth=40&format=${format}`),
      );
      const expected = {
        width: 40,
        height: Math.round((height * 40) / width),
        displayRotation: pose.replaceAll("_", "-"),
      };
      expect(JSON.parse(response.headers.get("X-Expo-Screenshot-Metadata")!)).toEqual(expected);
      const body = format === "base64" ? await response.json() : null;
      if (body) expect(body.metadata).toEqual(expected);
      const output = body
        ? Buffer.from(body.data, "base64")
        : Buffer.from(await response.arrayBuffer());
      const decoded = await sharp(output).metadata();
      expect([decoded.width, decoded.height]).toEqual([expected.width, expected.height]);
    }
  }
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
    await expect(
      screenshotResponse(async () => ({ png: Buffer.from("bad image") }), url),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    const png = await sharp({
      create: { width: 120, height: 260, channels: 4, background: "black" },
    })
      .png()
      .toBuffer();
    const response = await screenshotResponse(async () => ({ png }), url);
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

test("server total includes base64 response preparation", async () => {
  let clock = 0;
  const originalJson = Response.json.bind(Response);
  const timer = spyOn(performance, "now").mockImplementation(() => clock);
  const json = spyOn(Response, "json").mockImplementation((data, init) => {
    const response = originalJson(data, init);
    clock += 25;
    return response;
  });
  try {
    const response = await screenshotResponse(
      async () => ({ png: new Uint8Array([137, 80, 78, 71]) }),
      new URL("http://router.test/api/screenshot?format=base64"),
    );
    expect(response.headers.get("server-timing")).toContain("total;dur=25.000");
  } finally {
    json.mockRestore();
    timer.mockRestore();
  }
});
