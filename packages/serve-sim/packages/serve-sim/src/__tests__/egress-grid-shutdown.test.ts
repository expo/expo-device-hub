import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("grid shutdown preserves resident enrollment and the running session", async () => {
  const result = await runChildSuite("egress-grid-shutdown.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 60_000);
