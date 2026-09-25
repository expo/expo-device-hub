import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("camera status polling preserves capture through transient failures", async () => {
  const { exitCode, output } = await runChildSuite("camera-poll.child.ts", { timeoutMs: 30_000 });
  expect(output).toContain("20 pass");
  expect(exitCode).toBe(0);
}, 40_000);
