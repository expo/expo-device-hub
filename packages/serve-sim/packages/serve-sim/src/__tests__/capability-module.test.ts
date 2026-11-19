import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("capability imports preserve one manager, state and lock implementation without setup", () => {
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "fixtures/capability-module-import.child.ts")],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("Capability module compatibility and import purity passed.");
});
