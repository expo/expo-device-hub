import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Under SERVE_SIM_E2E_REQUIRED=1 a missing precondition must fail, never
// skip. That only holds for suites that call requireE2E(). This test keeps
// every suite that picks a simulator with e2eDevice() on that path.
test("every suite that calls e2eDevice() also calls requireE2E()", () => {
  const dir = import.meta.dir;
  const offenders = readdirSync(dir)
    .filter((name) => /\.test\.tsx?$/.test(name))
    .filter((name) => {
      const source = readFileSync(join(dir, name), "utf8");
      return source.includes("e2eDevice(") && !source.includes("requireE2E(");
    });
  expect(
    offenders,
    `add requireE2E("<what>", ready) next to the e2eDevice() gate in: ${offenders.join(", ")}`,
  ).toEqual([]);
});
