import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("native motion subscription parses and retires callbacks", async () => {
  const { exitCode, output } = await runChildSuite("native-device-state.child.ts");
  expect(output).toContain("2 pass");
  expect(exitCode).toBe(0);
});
