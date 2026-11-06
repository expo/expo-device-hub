import { expect, test } from "bun:test";

import { runChildSuite } from "./fixtures/run-child-suite";

// The real 3D scene and the real GLB models, with a fake browser and GPU. The
// fixture replaces `three`, so it runs in its own process.
test("the 3D scene with the shipped models", async () => {
  const { exitCode, output } = await runChildSuite("device-model-scene.child.ts");
  expect(output).toMatch(/\b6 pass\b/);
  expect(output).toMatch(/\b0 fail\b/);
  expect(exitCode).toBe(0);
}, 60_000);
