import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = join(import.meta.dir, "fixtures/capability-assets.child.ts");
const loader = "libServeSimCapabilityLoader.dylib";

test("capability assets resolve in source, relocated ESM/CJS and a compiled executable", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "capability-assets-")));
  const dist = join(directory, "relocated", "dist");
  const work = join(directory, "unrelated-working-directory");
  mkdirSync(join(dist, "capability-loader"), { recursive: true });
  mkdirSync(work);
  writeFileSync(join(dist, "capability-loader", loader), "probe asset");
  const run = (command: string, args: string[], base: string) => {
    const child = spawnSync(command, args, { cwd: work, encoding: "utf8", timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      base,
      directory: resolve(base, "..", "dist", "capability-loader"),
      path: resolve(base, "..", "dist", "capability-loader", loader),
      exists: true,
    });
  };
  try {
    run(process.execPath, [fixture], resolve(import.meta.dir, ".."));

    const esm = await Bun.build({
      entrypoints: [fixture],
      target: "node",
      format: "esm",
      outdir: dist,
      naming: "middleware.js",
    });
    expect(esm.success, String(esm.logs)).toBe(true);
    writeFileSync(join(dist, "package.json"), JSON.stringify({ type: "module" }));
    run("node", [join(dist, "middleware.js")], dist);
    copyFileSync(
      resolve(import.meta.dir, "../../dist/middleware.cjs"),
      join(dist, "middleware.cjs"),
    );
    run("node", [join(dist, "middleware.cjs")], dist);

    const stage = join(directory, "stage");
    const staged = await Bun.build({
      entrypoints: [fixture],
      target: "bun",
      format: "esm",
      outdir: stage,
      naming: "probe.js",
    });
    expect(staged.success, String(staged.logs)).toBe(true);
    const executable = join(dist, "probe");
    const compiled = spawnSync(
      process.execPath,
      ["build", "--compile", join(stage, "probe.js"), "--outfile", executable],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    run(executable, [], dist);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
