import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("browser camera lifecycle releases tracks and rejects stale capture", async () => {
  const { exitCode, output } = await runChildSuite("browser-camera.child.ts", { timeoutMs: 30_000 });
  expect(output).toContain("16 pass");
  expect(exitCode).toBe(0);
}, 40_000);
