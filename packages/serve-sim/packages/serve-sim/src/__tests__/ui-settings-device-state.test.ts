import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("device-backed UI option state follows the simulator boot", async () => {
  const { exitCode, output } = await runChildSuite("ui-settings-device-state.child.ts");
  expect(output).toContain("9 pass");
  expect(exitCode).toBe(0);
});
