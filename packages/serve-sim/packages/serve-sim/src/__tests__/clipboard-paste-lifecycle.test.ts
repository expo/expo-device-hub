import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Clipboard cancels retired reads and handles manual Copy failures", async () => {
  const { exitCode, output } = await runChildSuite("clipboard-paste-lifecycle.child.ts");
  expect(exitCode, output).toBe(0);
  expect(output).toMatch(/\b17 pass\b/);
}, 10_000);
