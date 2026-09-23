import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("fixed-panel routes preserve capture identity and release their resources", async () => {
  const result = await runChildSuite("device-session-panels.child.ts");
  expect(result.output).toContain("0 fail");
  expect(result.exitCode).toBe(0);
}, 20_000);
