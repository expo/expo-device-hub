import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = join(import.meta.dir, "fixtures/capability-assets.child.ts");
const loader = "libServeSimCapabilityLoader.dylib";
const tool = "serve-sim-pasteboard";
const reader = "libSimPasteboardReader.dylib";
const proxy = "libSimNetProxy.dylib";
const addon = "servesim_capture.py";
const cameraDylib = "libSimCameraInjector.dylib";
const cameraHelper = "serve-sim-camera-helper";
const source = resolve(import.meta.dir, "..");
const version = JSON.parse(readFileSync(resolve(source, "../package.json"), "utf8")).version;

test("capability assets resolve in source, relocated ESM/CJS and a compiled executable", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "capability-assets-")));
  const dist = join(directory, "relocated", "dist");
  const work = join(directory, "unrelated-working-directory");
  mkdirSync(join(dist, "capability-loader"), { recursive: true });
  mkdirSync(join(dist, "simpb"));
  mkdirSync(join(dist, "simnet"));
  mkdirSync(join(dist, "simcam"));
  mkdirSync(join(dist, "capture", "mitm-addon"), { recursive: true });
  mkdirSync(work);
  writeFileSync(join(dist, "capability-loader", loader), "probe asset");
  writeFileSync(join(dist, "simpb", tool), "probe tool");
  writeFileSync(join(dist, "simpb", reader), "probe reader");
  writeFileSync(join(dist, "simnet", proxy), "probe proxy");
  writeFileSync(join(dist, "simcam", cameraDylib), "probe camera dylib");
  writeFileSync(join(dist, "simcam", cameraHelper), "probe camera helper");
  writeFileSync(join(dist, "capture", "mitm-addon", addon), "probe addon");
  writeFileSync(resolve(dist, "../package.json"), JSON.stringify({ version }));
  const run = (command: string, args: string[], base: string, override?: string) => {
    const child = spawnSync(command, args, {
      cwd: work,
      env: { ...process.env, SERVE_SIM_SIMPB_DIR: override },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      base,
      directory: resolve(base, "..", "dist", "capability-loader"),
      path: resolve(base, "..", "dist", "capability-loader", loader),
      exists: true,
      pasteboardTool: join(override ?? resolve(base, "..", "dist", "simpb"), tool),
      pasteboardReader: join(override ?? resolve(base, "..", "dist", "simpb"), reader),
      networkDylib: resolve(base, "..", "dist", "simnet", proxy),
      networkAddon:
        base === source
          ? join(base, "capabilities", "network-capture", "mitm-addon", addon)
          : join(base, "capture", "mitm-addon", addon),
      cameraDylib: resolve(base, "..", "dist", "simcam", cameraDylib),
      cameraHelper: resolve(base, "..", "dist", "simcam", cameraHelper),
      version,
    });
  };
  try {
    run(process.execPath, [fixture], resolve(import.meta.dir, ".."));
    const override = join(directory, "override");
    mkdirSync(override);
    writeFileSync(join(override, tool), "override tool");
    writeFileSync(join(override, reader), "override reader");
    run(process.execPath, [fixture], resolve(import.meta.dir, ".."), override);

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
