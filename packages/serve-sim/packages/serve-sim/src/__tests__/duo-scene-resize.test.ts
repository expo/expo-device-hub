import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

// Keep the browser and GPU mocks isolated from other scene and UI tests.
test("Duo scene resize and hinge handle lifecycle", async () => {
  const { exitCode, output } = await runChildSuite("duo-scene-resize.child.ts");
  expect(output).toContain("4 pass");
  expect(exitCode).toBe(0);
}, 10_000);
