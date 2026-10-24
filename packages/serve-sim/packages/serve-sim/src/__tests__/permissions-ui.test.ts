import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("permission UI reads authoritative state and rejects stale targets", async () => {
  const { exitCode, output } = await runChildSuite("permissions-ui.child.ts");
  expect(exitCode, output).toBe(0);
  expect(output).toMatch(/\b10 pass\b/);
}, 10_000);
