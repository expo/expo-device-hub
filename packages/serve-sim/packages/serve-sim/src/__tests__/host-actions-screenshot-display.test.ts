import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("screenshots follow the active display unless one is explicitly selected", async () => {
  const { exitCode, output } = await runChildSuite("screenshot-display.child.ts");
  expect(output).toContain("6 pass");
  expect(exitCode).toBe(0);
}, 30_000);
