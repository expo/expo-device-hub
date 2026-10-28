import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("adoption confirms shutdown and preserves foreign Simulator ownership", async () => {
  const { exitCode, output } = await runChildSuite("adoption-shutdown.child.ts");
  expect(exitCode, output).toBe(0);
  expect(output).toContain("15 pass");
}, 30_000);
