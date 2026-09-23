import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Duo independent panel streams", async () => {
  const { exitCode, output } = await runChildSuite("duo-scene-panels.child.ts");
  expect(output).toContain("16 pass");
  expect(exitCode).toBe(0);
}, 10_000);
