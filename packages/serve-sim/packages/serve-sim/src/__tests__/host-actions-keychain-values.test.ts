import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Keychain controls preserve credential keys and limits in a child process", async () => {
  const { exitCode, output } = await runChildSuite("host-actions-keychain-values.child.ts", {
    timeoutMs: 20_000,
  });
  expect(output).toContain("10 pass");
  expect(output).toContain("controls preserve a sole __proto__ credential");
  expect(output).toContain("the control catalog keeps an object-shaped credential schema");
  expect(exitCode).toBe(0);
}, 30_000);
