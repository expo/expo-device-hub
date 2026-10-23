import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("same-name capture publication and failed reservation cleanup are serialized", async () => {
  const result = await runChildSuite("screenshot-publication.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 10_000);
