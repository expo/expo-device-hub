import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("native HID setup distinguishes service failure from missing key encoding", async () => {
  const { exitCode, output } = await runChildSuite("native-hid-setup.child.ts");
  expect(output).toContain("2 pass");
  expect(exitCode).toBe(0);
});
