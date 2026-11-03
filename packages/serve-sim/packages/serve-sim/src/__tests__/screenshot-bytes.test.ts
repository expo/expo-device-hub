import { expect, test } from "bun:test";
import { captureNativeScreenshotAsync } from "../screenshot-store";

test("returns only pixels validated against the active panel after capture", async () => {
  const displays: number[] = [];
  const pixels = await captureNativeScreenshotAsync(
    1,
    async () => 3,
    async (display) => {
      displays.push(display);
      return Buffer.from([display]);
    },
  );
  expect(displays).toEqual([1, 3]);
  expect(pixels).toEqual(Buffer.from([3]));
});

test("bounds display handoff retries without publishing unvalidated pixels", async () => {
  let display = 1;
  await expect(
    captureNativeScreenshotAsync(
      1,
      async () => ++display,
      async () => Buffer.from("png"),
    ),
  ).rejects.toThrow("active display kept changing");
  expect(display).toBe(4);
});
