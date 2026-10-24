import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("single-display fallback reads device identifiers and installed capability profiles", async () => {
  const result = await runChildSuite("devicekit-display-profile.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 30_000);
