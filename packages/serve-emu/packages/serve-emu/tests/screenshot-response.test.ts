import { expect, test } from "bun:test";
import { captureScreenshot, screenshotResponse } from "../src/screenshot-response.ts";

// An allowed cross-origin caller can read a custom header only when the response lists it, as serve-sim's does.
test("lets a cross-origin caller read the screenshot artifact headers", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

  for (const url of [
    "http://router.test/api/screenshot",
    "http://router.test/api/screenshot?format=base64",
  ]) {
    const response = await screenshotResponse(png, new URL(url));
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Expo-Screenshot-Artifact, X-Expo-Screenshot-Artifact-Error, X-Expo-Screenshot-Metadata",
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
  const raw = await screenshotResponse(png, new URL("http://router.test/api/screenshot"), metadata);
  expect(JSON.parse(raw.headers.get("X-Expo-Screenshot-Metadata")!)).toEqual(metadata);
  expect(new Uint8Array(await raw.arrayBuffer())).toEqual(png);
  const json = await screenshotResponse(
    png,
    new URL("http://router.test/api/screenshot?format=base64"),
    metadata,
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
