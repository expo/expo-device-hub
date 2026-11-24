import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Simulator UI subprocess failures are bounded", async () => {
  const { exitCode, output } = await runChildSuite("ui-settings-timeout.child.ts");
  expect(output).toContain("5 pass");
  expect(exitCode).toBe(0);
});
