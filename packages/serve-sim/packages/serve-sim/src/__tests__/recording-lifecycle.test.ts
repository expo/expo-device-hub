import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("recording startup cancellation and shutdown failures", async () => {
  const { exitCode, output } = await runChildSuite("recording-lifecycle.child.ts");
  expect(output).toContain("10 pass");
  expect(exitCode).toBe(0);
}, 10_000);
