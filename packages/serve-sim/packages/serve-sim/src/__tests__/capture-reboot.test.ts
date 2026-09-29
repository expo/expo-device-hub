import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("capture reboot ordering, joining and intent changes pass in their own process", async () => {
  const { exitCode, output } = await runChildSuite("capture-reboot.child.ts", { timeoutMs: 45_000 });
  expect(output).toContain("0 fail");
  expect(exitCode).toBe(0);
}, 60_000);
