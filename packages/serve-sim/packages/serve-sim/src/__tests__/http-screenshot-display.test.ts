import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";
test("HTTP screenshots preserve native sessions and verify cold-session direct capture", async () => {
  const result = await runChildSuite("http-screenshot-display.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 30_000);
