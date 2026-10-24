import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("capture field picks survive device switches and a closed Tools panel", async () => {
  const { exitCode, output } = await runChildSuite("capture-field-choices.child.tsx");
  expect(output).toContain("11 pass");
  expect(exitCode).toBe(0);
}, 10_000);
