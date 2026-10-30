import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("egress panel uses acknowledged policy and discards stale device responses", async () => {
  const result = await runChildSuite("egress-panel.child.tsx");
  expect(result.exitCode, result.output).toBe(0);
});
