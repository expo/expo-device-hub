import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("the middleware refuses capture on an ungated preview unless the host binds to loopback", async () => {
  const { exitCode, output } = await runChildSuite("capture-host-policy.child.ts", { timeoutMs: 45_000 });
  expect(output).toContain("0 fail");
  expect(exitCode).toBe(0);
}, 60_000);
