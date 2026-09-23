import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("stream hooks reject retired frames and preserve independent panel ownership", async () => {
  const { exitCode, output } = await runChildSuite("stream-hook-lifecycle.child.ts");
  expect(output).toContain("7 pass");
  expect(exitCode).toBe(0);
}, 10_000);
