import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("keychain format-option refusals and valid credentials in a child process", async () => {
  const { exitCode, output } = await runChildSuite("keychain-format-options.child.ts", {
    timeoutMs: 20_000,
  });
  expect(output).toContain("5 pass");
  expect(output).toContain("react-native-keychain refuses a separate service option");
  expect(output).toContain("valid credentials preserve service and username");
  expect(output).toContain("KeychainAccess refuses missing context");
  expect(exitCode).toBe(0);
}, 30_000);
