import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("background screenshot options preserve manual capture and active-display selection", async () => {
  const result = await runChildSuite("screenshot-preview.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 10_000);
