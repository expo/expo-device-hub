import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

// Keep the native addon mocks out of the process that runs simulator E2E tests.
test("device sessions follow the active native screen", async () => {
  const { exitCode, output } = await runChildSuite("device-session-screen-config.child.ts");
  expect(output).toContain("70 pass");
  expect(exitCode).toBe(0);
}, 10_000);
