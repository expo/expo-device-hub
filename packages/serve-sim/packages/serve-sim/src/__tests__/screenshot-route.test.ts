import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("HTTP and binary socket screenshots share validation, pixels and retry failures", async () => {
  const result = await runChildSuite("screenshot-route.child.ts");
  expect(result.exitCode, result.output).toBe(0);
});
