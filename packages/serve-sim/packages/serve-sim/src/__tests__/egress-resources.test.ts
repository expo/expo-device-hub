import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("resident egress preboot preparation and boot lifetime", async () => {
  const result = await runChildSuite("egress-resources.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 60_000);
