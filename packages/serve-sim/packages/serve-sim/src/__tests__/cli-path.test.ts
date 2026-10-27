import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { serveSimCliPath } from "../cli-path";

describe("serve-sim CLI entry", () => {
  test("source execution uses the source CLI even when dist exists", () => {
    expect(serveSimCliPath()).toBe(resolve(import.meta.dir, "../index.ts"));
  });

  test.each([false, true])("build selects the CLI entry (compiled=%j)", async (compiled) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "serve-sim cli with spaces-")));
    try {
      const entry = join(dir, "entry.ts");
      const output = join(dir, "middleware.mjs");
      writeFileSync(
        entry,
        `import { serveSimCliPath } from ${JSON.stringify(resolve(import.meta.dir, "../cli-path.ts"))};
         console.log(JSON.stringify({ cli: serveSimCliPath(), executable: process.execPath }));`,
      );
      // Both outputs can be colocated; compiled mode must still launch itself.
      writeFileSync(join(dir, "serve-sim.js"), "");
      const built = await Bun.build({
        entrypoints: [entry],
        target: "node",
        format: "esm",
        minify: true,
        naming: "middleware.mjs",
        outdir: dir,
        define: { __SERVE_SIM_COMPILED__: String(compiled) },
      });
      expect(built.success).toBe(true);
      const child = spawnSync("node", [output], {
        encoding: "utf8",
        env: { ...process.env },
        timeout: 10_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.cli).toBe(compiled ? result.executable : join(dir, "serve-sim.js"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
