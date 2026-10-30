import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("adoption confirms shutdown and preserves foreign Simulator ownership", async () => {
  const { exitCode, output } = await runChildSuite("adoption-shutdown.child.ts");
  expect(exitCode, output).toBe(0);
  expect(output).toContain("18 pass");
}, 30_000);

test("preview publication does not wait synchronously on another process", async () => {
  const { exitCode, output } = await runChildSuite("state-publication-busy.child.ts", {
    timeoutMs: 2000,
  });
  expect(exitCode, output).toBe(0);
  expect(output).toContain("1 pass");
});
