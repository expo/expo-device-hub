import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";
test("hinge readback preserves acknowledged controls, external state, and sensor semantics", async () => {
  const result = await runChildSuite("hinge-readback.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 15000);
