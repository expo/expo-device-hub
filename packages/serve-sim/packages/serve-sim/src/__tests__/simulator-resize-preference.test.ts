import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("panel constraints preserve the preferred frame size and explicit resizing", async () => {
  const { exitCode, output } = await runChildSuite("simulator-resize.child.ts");
  expect(output).toContain("9 pass");
  expect(exitCode).toBe(0);
}, 10_000);
