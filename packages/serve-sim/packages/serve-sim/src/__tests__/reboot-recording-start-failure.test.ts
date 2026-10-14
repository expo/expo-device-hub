import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("recording startup failure does not strand reboot input recovery", async () => {
  const result = await runChildSuite("reboot-recording-start-failure.child.ts");
  expect(result.output).toContain("1 pass");
  expect(result.exitCode, result.output).toBe(0);
});
