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

// CI runs the *.e2e.test.* suites with SERVE_SIM_E2E_REQUIRED=1 after the simulator
// boots, and ignores them in the isolated unit run. A suite whose preconditions must
// fail in CI (a simulator, or a built artifact) calls requireE2E(), so it must have
// that name; the test above already holds every e2eDevice() suite to requireE2E().
test("every suite that calls requireE2E() is named *.e2e.test.*", () => {
  const dir = import.meta.dir;
  const offenders = readdirSync(dir)
    .filter((name) => /\.test\.tsx?$/.test(name) && !/\.e2e\.test\.tsx?$/.test(name))
    .filter((name) => name !== "e2e-preconditions-pairing.test.ts")
    .filter((name) => readFileSync(join(dir, name), "utf8").includes("requireE2E("));
  expect(offenders, `rename to *.e2e.test.ts: ${offenders.join(", ")}`).toEqual([]);
});
