import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("sidecar persistence failures clean up their owned files", async () => {
  const result = await runChildSuite("screenshot-sidecar-failures.child.ts");
  expect(result.exitCode, result.output).toBe(0);
});
