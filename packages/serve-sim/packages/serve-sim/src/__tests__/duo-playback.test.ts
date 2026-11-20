import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("Duo playback recovery stays outside the hidden texture source", async () => {
  const result = await runChildSuite("duo-playback.child.tsx");
  expect(result.output).toContain("0 fail");
  expect(result.exitCode).toBe(0);
}, 20_000);
