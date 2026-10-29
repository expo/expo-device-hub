import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("adoption reuses prepared devices and retires the others in the background", async () => {
  const { exitCode, output } = await runChildSuite("warm-device-reuse.child.ts");
  expect(exitCode, output).toBe(0);
  expect(output).toContain("4 pass");
}, 30_000);
