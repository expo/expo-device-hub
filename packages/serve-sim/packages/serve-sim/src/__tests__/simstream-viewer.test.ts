import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("simstream viewer hooks restore their choices and surface RTP negotiation failures", async () => {
  const { exitCode, output } = await runChildSuite("simstream-viewer.child.ts");
  expect(output).toContain("6 pass");
  expect(exitCode).toBe(0);
}, 20_000);
