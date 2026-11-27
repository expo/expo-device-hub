import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Keychain CLI validates credentials and formats write results in a child process", async () => {
  const { exitCode, output } = await runChildSuite("keychain-cli-input.child.ts", {
    timeoutMs: 20_000,
  });
  expect(output).toContain("8 pass");
  expect(output).toContain("JSON and pair input preserve a __proto__ credential");
  expect(output).toContain("JSON preserves file-over-pair precedence for __proto__");
  expect(output).toContain("write summaries explain ambiguous access groups");
  expect(exitCode).toBe(0);
}, 30_000);
