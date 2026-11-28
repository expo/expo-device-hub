import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("keychain middleware policy, setup backoff, and recovery in a child process", async () => {
  const { exitCode, output } = await runChildSuite("middleware-keychain-actions.child.ts", {
    timeoutMs: 20_000,
  });
  expect(exitCode, output).toBe(0);
  expect(output).toContain("8 pass");
  expect(output).toContain("a failed preview setup refuses actions during backoff and recovers");
}, 30_000);
