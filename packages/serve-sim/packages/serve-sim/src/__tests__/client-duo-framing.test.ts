import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("the App reconciles native Duo framing after external changes and failed controls", async () => {
  // Browser globals and module mocks stay in the child rather than leaking to other suites.
  const { exitCode, output } = await runChildSuite("client-duo-framing.child.tsx");
  expect(exitCode, output).toBe(0);
}, 10_000);
