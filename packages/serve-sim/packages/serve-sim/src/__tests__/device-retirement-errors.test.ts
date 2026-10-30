import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("device retirement preserves errors without blocking another device", async () => {
  const result = await runChildSuite("device-retirement-errors.child.ts");
  expect(result.exitCode, result.output).toBe(0);
});
