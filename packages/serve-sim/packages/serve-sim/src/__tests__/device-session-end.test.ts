import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("a device that goes away ends its session and tells its viewers why", async () => {
  const result = await runChildSuite("device-session-end.child.ts");
  expect(result.output).toContain("2 pass");
  expect(result.exitCode, result.output).toBe(0);
});
