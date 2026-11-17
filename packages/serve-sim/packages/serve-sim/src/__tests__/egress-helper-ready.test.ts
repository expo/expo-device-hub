import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("CLI helper cannot publish ready for a boot lost during preview binding", async () => {
  const result = await runChildSuite("egress-helper-ready.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 60_000);
