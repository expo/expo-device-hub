import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("fresh Camera imports leave setup and process handlers untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "camera-module-"));
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/camera-module-import.child.ts", import.meta.url)),
      ],
      {
        env: { ...process.env, SERVE_SIM_STATE_DIR: directory },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toContain(
      "without setup or host runtime imports",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
