import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("explicit egress startup requires native artifacts before boot, app actions or ready", async () => {
  const result = await runChildSuite("egress-startup.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 60_000);
