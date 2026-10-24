import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Duo helpers await independently observed state", async () => {
  const { exitCode, output } = await runChildSuite("duo-hinge-helpers.child.ts");
  expect(output).toContain("4 pass");
  expect(exitCode).toBe(0);
});
