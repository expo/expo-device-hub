import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Paste cancels retired clipboard reads and manual callbacks", async () => {
  const { exitCode, output } = await runChildSuite("clipboard-paste-lifecycle.child.ts");
  expect(exitCode, output).toBe(0);
  expect(output).toMatch(/\b5 pass\b/);
}, 10_000);
