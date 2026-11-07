import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("capability admission, preparation, polling, and draining in a child process", async () => {
  const { exitCode, output } = await runChildSuite("capability-operation-drain.child.ts", {
    timeoutMs: 20_000,
  });
  expect(output).toContain("6 pass");
  expect(output).toContain("refuses startup-disabled, unopened, and unmanaged capability changes");
  expect(output).toContain("disable drains action preparation before removing setup");
  expect(exitCode).toBe(0);
}, 30_000);
