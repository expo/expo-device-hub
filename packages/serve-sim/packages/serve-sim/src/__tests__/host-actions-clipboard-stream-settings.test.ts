import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

// Confine native module replacements to a child process.
test("clipboard actions preserve the owning middleware's stream settings before a viewer", async () => {
  const { exitCode, output } = await runChildSuite("clipboard-stream-settings.child.ts");
  expect(output).toContain("2 pass");
  expect(exitCode).toBe(0);
}, 30_000);
