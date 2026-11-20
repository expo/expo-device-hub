import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("native bindings carry the physical device kind, end signal, and support report", async () => {
  const { exitCode, output } = await runChildSuite("native-physical.child.ts");
  expect(output).toContain("3 pass");
  expect(exitCode).toBe(0);
});
