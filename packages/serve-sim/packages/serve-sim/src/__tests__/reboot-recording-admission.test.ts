import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";
test("reboot admission rejects new recordings while allowing the existing lease and stop", async () => {
  const result = await runChildSuite("reboot-recording-admission.child.ts");
  expect(result.output).toContain("3 pass");
  expect(result.exitCode, result.output).toBe(0);
});
