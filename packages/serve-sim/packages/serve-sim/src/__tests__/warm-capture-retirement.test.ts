import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("warm retirement drains Capture before ownership release and retries failures", async () => {
  const { exitCode, output } = await runChildSuite("warm-capture-retirement.child.ts", {
    timeoutMs: 20_000,
  });
  expect(exitCode, output).toBe(0);
  expect(output).toContain("2 pass");
}, 30_000);
