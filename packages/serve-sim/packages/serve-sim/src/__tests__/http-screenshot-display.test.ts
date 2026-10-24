import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";
test("HTTP and host screenshots share native display selection and startup failures", async () => {
  const result = await runChildSuite("http-screenshot-display.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 30_000);
