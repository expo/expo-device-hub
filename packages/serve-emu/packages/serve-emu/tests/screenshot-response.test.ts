import { expect, test } from "bun:test";
import { screenshotResponse } from "../src/screenshot-response.ts";

// An allowed cross-origin caller can read a custom header only when the response lists it, as serve-sim's does.
test("lets a cross-origin caller read the screenshot artifact headers", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

  for (const url of ["http://router.test/api/screenshot", "http://router.test/api/screenshot?format=base64"]) {
    const response = await screenshotResponse(png, new URL(url));
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Expo-Screenshot-Artifact, X-Expo-Screenshot-Artifact-Error",
    );
  }
});
