import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("Capture imports share one runtime without starting resources", () => {
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "fixtures/capture-module-import.child.ts")],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("Capture module compatibility and import purity passed.");
});
