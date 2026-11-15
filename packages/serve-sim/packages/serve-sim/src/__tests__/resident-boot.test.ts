import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("resident boot commands preserve the bound page and initial boot environment", async () => {
  const { exitCode, output } = await runChildSuite("resident-boot.child.ts");
  expect(exitCode, output).toBe(0);
  expect(output).toContain("6 pass");
}, 60_000);
