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

test("capture reads only the observed local cache and drops a pose changed during capture", async () => {
  const { createDisplayOrientationReader } = await import("../src/display-orientation.ts");
  let reads = 0;
  const { reader, locked } = createDisplayOrientationReader({
    read: async () => {
      reads++;
      return "landscape_left";
    },
  });
  await reader.fresh();
  const png = new Uint8Array([137, 80, 78, 71]);
  const shot = await captureScreenshot(async () => png, reader);
  expect(shot.metadata.displayRotation).toBe("landscape-left");
  expect(shot.metadata.width).toBe(0);
  expect(reads).toBe(1);
  const changed = await captureScreenshot(async () => {
    locked("portrait");
    return png;
  }, reader);
  expect(changed.metadata.displayRotation).toBeNull();
  expect(changed.png).toBe(png);
  expect(reads).toBe(1);
});
