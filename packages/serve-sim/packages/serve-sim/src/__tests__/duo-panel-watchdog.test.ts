import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Duo AVCC startup watchdog follows the intended panel", async () => {
  const result = await runChildSuite("duo-panel-watchdog.child.ts");
  expect(result.output).toContain("0 fail");
  expect(result.exitCode).toBe(0);
}, 20_000);
