import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("reboot replaces HID routing without replaying old controls", async () => {
  const result = await runChildSuite("device-session-reboot.child.ts");
  expect(result.output).toContain("30 pass");
  expect(result.exitCode, result.output).toBe(0);
});
