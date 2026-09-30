import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("the capture starter's failed-start latch skips and stays latched in its own process", async () => {
  const { exitCode, output } = await runChildSuite("capture-start.child.ts", { timeoutMs: 45_000 });
  expect(output).toContain("0 fail");
  expect(exitCode).toBe(0);
}, 60_000);
