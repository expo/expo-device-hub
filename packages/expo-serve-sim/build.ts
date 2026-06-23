#!/usr/bin/env bun
/**
 * Vendor serve-sim into this package.
 *
 * expo-serve-sim ships without a dependency on the `serve-sim` npm package.
 * Instead we `npm pack` serve-sim and unpack the tarball into
 * `vendor/serve-sim`, reproducing exactly the file layout serve-sim publishes:
 *
 *   vendor/serve-sim/dist/middleware.cjs|.js   the fetch middleware
 *   vendor/serve-sim/dist/serve-sim.js         the CLI spawned via `--detach`
 *   vendor/serve-sim/dist/simcam/*             camera injector dylib + helper
 *   vendor/serve-sim/dist/simax/*              sim-ax-settings helper
 *   vendor/serve-sim/bin/serve-sim-bin         the Swift helper daemon
 *   vendor/serve-sim/LICENSE                   Apache-2.0 (attribution)
 *
 * Packing (rather than cherry-picking artifacts) keeps serve-sim's intended
 * layout intact, so the CLI's own runtime path resolution — e.g. the
 * `../bin/serve-sim-bin` fallback in findHelperBinary — works unchanged.
 *
 * `ws` and `inspect-webkit` stay external in serve-sim's bundles and are
 * declared as our own runtime dependencies, so Node resolves them by walking
 * up from vendor/serve-sim into expo-serve-sim/node_modules.
 *
 * The vendored tree is gitignored; this runs on `build` (and before publish).
 */
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, copyFileSync } from "fs";
import { spawnSync } from "child_process";

const root = import.meta.dir;
const vendorDir = resolve(root, "vendor");
const vendoredServeSim = join(vendorDir, "serve-sim");

// serve-sim lives elsewhere in the monorepo; allow an override for CI layouts.
const serveSimDir = resolve(
  root,
  process.env.SERVE_SIM_DIR ?? "../serve-sim/packages/serve-sim",
);

if (!existsSync(join(serveSimDir, "package.json"))) {
  console.error(`serve-sim not found at ${serveSimDir}`);
  console.error("Set SERVE_SIM_DIR to the serve-sim package directory.");
  process.exit(1);
}

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ─── 1. Build serve-sim ───────────────────────────────────────────────────
// `build.ts` emits dist/ (incl. simcam/simax helpers); the Swift helper daemon
// `bin/serve-sim-bin` is produced separately by build:swift — build it only if
// it's missing (a `swift build` is slow and the artifact is usually prebuilt).
console.log("Building serve-sim…");
run("bun", ["run", "build.ts"], serveSimDir);
if (!existsSync(join(serveSimDir, "bin/serve-sim-bin"))) {
  console.log("bin/serve-sim-bin missing — running build:swift…");
  run("bash", ["build.sh"], serveSimDir);
}

// ─── 2. Pack serve-sim into a tarball ─────────────────────────────────────
rmSync(vendoredServeSim, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });

const pack = spawnSync("npm", ["pack", "--pack-destination", vendorDir, "--json"], {
  cwd: serveSimDir,
  encoding: "utf-8",
});
if (pack.status !== 0) {
  console.error(pack.stderr);
  process.exit(pack.status ?? 1);
}
const filename = JSON.parse(pack.stdout)[0].filename as string;
const tgz = join(vendorDir, filename);

// ─── 3. Unpack into vendor/serve-sim (strip the leading package/ dir) ─────
mkdirSync(vendoredServeSim, { recursive: true });
run("tar", ["-xzf", tgz, "-C", vendoredServeSim, "--strip-components=1"], root);
rmSync(tgz, { force: true });

// serve-sim's Apache-2.0 LICENSE lives at its repo root, not inside the
// package dir, so `npm pack` doesn't include it. Copy it in so the attribution
// our LICENSE/NOTICE point to (vendor/serve-sim/LICENSE) is always present.
if (!existsSync(join(vendoredServeSim, "LICENSE"))) {
  const repoLicense = resolve(serveSimDir, "../../LICENSE");
  if (!existsSync(repoLicense)) {
    console.error(`serve-sim LICENSE not found at ${repoLicense}`);
    process.exit(1);
  }
  copyFileSync(repoLicense, join(vendoredServeSim, "LICENSE"));
}

console.log(`Vendored serve-sim → vendor/serve-sim`);
console.log("Done.");
