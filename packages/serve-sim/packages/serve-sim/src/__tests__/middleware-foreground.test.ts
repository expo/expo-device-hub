import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("appstate clears the previous target on the same SSE connection", async () => {
  const result = await runChildSuite("middleware-foreground.child.ts", { timeoutMs: 10_000 });
  expect(result.output).toContain("1 pass");
  expect(result.exitCode).toBe(0);
}, 15_000);
