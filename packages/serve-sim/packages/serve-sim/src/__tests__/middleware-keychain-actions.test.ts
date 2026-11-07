import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("keychain middleware policy, setup backoff, and recovery in a child process", async () => {
  const { exitCode, output } = await runChildSuite("middleware-keychain-actions.child.ts", {
    timeoutMs: 20_000,
  });
  expect(output).toContain("7 pass");
  expect(output).toContain("a failed preview setup refuses actions during backoff and recovers");
  expect(exitCode).toBe(0);
}, 30_000);
