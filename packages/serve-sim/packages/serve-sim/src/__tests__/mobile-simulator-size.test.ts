import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("mobile sizing refits for keyboard, wrapped actions, landscape, and desktop", () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, "fixtures/mobile-simulator-size.child.tsx")],
    { encoding: "utf8" },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 15_000);
