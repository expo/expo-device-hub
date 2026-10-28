import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { useTempStateDir } from "./helpers";

test("the Node middleware starts without a native build", () => {
  const pkg = join(import.meta.dir, "../..");
  // Keep the temporary bundle inside the package so Node can resolve ws.
  const dir = mkdtempSync(join(pkg, ".middleware-startup-"));
  const state = useTempStateDir();
  try {
    // Isolate the bundler from earlier tests; in-process builds fail in the full shards.
    const built = spawnSync(
      process.execPath,
      [
        "build",
        join(pkg, "src/middleware.ts"),
        "--target",
        "node",
        "--format",
        "esm",
        "--external",
        "ws",
        "--define",
        "__SERVE_SIM_COMPILED__=false",
        "--outdir",
        dir,
      ],
      {
        encoding: "utf8",
        env: { ...process.env },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    expect(built.error).toBeUndefined();
    expect(built.status, built.stderr).toBe(0);
    const child = spawnSync(
      "node",
      [join(import.meta.dir, "fixtures/middleware-startup.child.mjs"), join(dir, "middleware.js")],
      {
        encoding: "utf8",
        env: { ...process.env },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("serve-sim middleware initializes on Node");
  } finally {
    state.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
