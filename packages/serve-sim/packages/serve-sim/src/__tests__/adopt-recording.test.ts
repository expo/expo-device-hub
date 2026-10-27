import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";
test("adopted recording ownership, cancellation and finalization", async () => {
  const { exitCode, output } = await runChildSuite("adopt-recording.child.ts");
  expect(exitCode, output).toBe(0);
});
