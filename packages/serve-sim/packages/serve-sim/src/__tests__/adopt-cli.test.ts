import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("CLI adoption accepts build-tools flags and refuses incompatible processes", async () => {
  const { exitCode, output } = await runChildSuite("adopt-cli.child.ts");
  expect(output).toContain("pass");
  expect(exitCode, output).toBe(0);
}, 60_000);
