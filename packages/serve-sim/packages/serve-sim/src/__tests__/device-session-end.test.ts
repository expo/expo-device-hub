import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("a phone's session is physical and ends when the phone goes away", async () => {
  const result = await runChildSuite("device-session-end.child.ts");
  expect(result.output).toContain("4 pass");
  expect(result.exitCode, result.output).toBe(0);
});
