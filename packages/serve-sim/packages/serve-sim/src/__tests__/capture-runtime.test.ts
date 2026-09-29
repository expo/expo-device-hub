import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("capture runtime failure paths and cancellation pass in their own process", async () => {
  const { exitCode, output } = await runChildSuite("capture-runtime.child.ts", { timeoutMs: 45_000 });
  expect(output).toContain("0 fail");
  expect(exitCode).toBe(0);
}, 60_000);
