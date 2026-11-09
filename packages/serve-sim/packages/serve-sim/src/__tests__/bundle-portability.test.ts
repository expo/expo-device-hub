import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { useTempStateDir } from "./helpers";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// The published bundles must locate sibling artifacts (dist/simax,
// dist/simcam) relative to wherever npm installed them. Bun's bundler
// replaces a bare CommonJS `__dirname` with the *build machine's* source
// directory as a string constant, which resolves fine on the machine that
// built the package (masking the bug in local testing) and on nobody
// else's — `npx @expo/serve-sim` then fails with "sim-ax-settings binary not
// found". Modules needing __dirname must shadow it with
// `dirnameOf(import.meta.url)` (see src/runtime.ts); this suite catches
// any bundle that picked up the compile-time constant instead.

const PKG_DIR = join(import.meta.dir, "../..");
const SRC_DIR = join(PKG_DIR, "src");

const BUNDLES = ["dist/serve-sim.js", "dist/middleware.js", "dist/state.js"] as const;
const ARM64_MACH_O_ARTIFACTS = [
  "dist/serve-sim",
  "dist/native/serve-sim-native.node",
  "dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC",
  "dist/simcam/libSimCameraInjector.dylib",
  "dist/simcam/serve-sim-camera-helper",
  "dist/simax/serve-sim-ax-settings",
  "dist/simperm/serve-sim-permissions",
  "dist/simpb/libSimPasteboardReader.dylib",
  "dist/simpb/serve-sim-pasteboard",
  "dist/capability-loader/libServeSimCapabilityLoader.dylib",
] as const;

// CI builds dist before running this directory; locally, run
// `bun run build.ts` first or the suite skips.
const describeIfBuilt = BUNDLES.every((b) => existsSync(join(PKG_DIR, b)))
  ? describe
  : describe.skip;

describe("package attribution", () => {
  test("publishes the upstream attribution notice", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    const notice = readFileSync(join(PKG_DIR, "NOTICE"), "utf8");
    const repositoryNotice = readFileSync(join(PKG_DIR, "../..", "NOTICE"), "utf8");

    expect(pkg.files).toContain("NOTICE");
    expect(notice).toBe(repositoryNotice);
    expect(notice).toContain("Evan Bacon");
    expect(notice).toContain("https://github.com/EvanBacon/serve-sim");
    expect(notice).toContain("Apache License, Version 2.0");
  });
});

describeIfBuilt("bundle portability", () => {
  test.each([...BUNDLES])("%s has no build-machine path baked in", (bundle) => {
    const js = readFileSync(join(PKG_DIR, bundle), "utf-8");
    expect(js).not.toContain(SRC_DIR);
  });

  test("both published packages include the permissions helper", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    const hub = JSON.parse(
      readFileSync(join(PKG_DIR, "../../../expo-device-hub/package.json"), "utf8"),
    );
    expect(pkg.files).toContain("dist/simperm/serve-sim-permissions");
    expect(hub.files).toContain("vendor/serve-sim/dist/simperm");
    expect(hub.files).toContain("vendor/serve-sim/package.json");
    execFileSync("codesign", [
      "--verify",
      "--strict",
      join(PKG_DIR, "dist/simperm/serve-sim-permissions"),
    ]);
  });

  test.each(["package", "vendor"])(
    "the shipped Node middleware dispatches without warnings in %s layout",
    (layout) => {
      const state = useTempStateDir();
      let fixture: string | undefined;
      try {
        let cwd = PKG_DIR;
        let middleware = "./dist/middleware.js";
        if (layout === "vendor") {
          const hub = JSON.parse(
            readFileSync(join(PKG_DIR, "../../../expo-device-hub/package.json"), "utf8"),
          );
          expect(hub.files).toContain("vendor/serve-sim/package.json");
          fixture = mkdtempSync(join(tmpdir(), "serve-sim-vendor-"));
          const scripts = join(fixture, "scripts");
          const source = join(fixture, "node_modules/@expo/serve-sim");
          mkdirSync(scripts, { recursive: true });
          mkdirSync(join(source, "dist"), { recursive: true });
          cpSync(
            join(PKG_DIR, "../../../expo-device-hub/scripts/vendor.ts"),
            join(scripts, "vendor.ts"),
          );
          for (const file of ["middleware.js", "serve-sim.js"])
            cpSync(join(PKG_DIR, "dist", file), join(source, "dist", file));
          writeFileSync(
            join(source, "package.json"),
            JSON.stringify({
              name: "@expo/serve-sim",
              version: "0.0.0",
              type: "module",
              files: ["dist"],
            }),
          );
          writeFileSync(
            join(fixture, "package.json"),
            JSON.stringify({
              name: "hub-vendor-test",
              vendorDependencies: { "@expo/serve-sim": "workspace:*" },
            }),
          );
          symlinkSync(join(PKG_DIR, "node_modules/ws"), join(fixture, "node_modules/ws"), "dir");
          const vendor = spawnSync(process.execPath, [join(scripts, "vendor.ts")], {
            cwd: fixture,
            env: { ...process.env },
            encoding: "utf8",
            timeout: 20_000,
          });
          expect(vendor.status, vendor.stderr).toBe(0);
          cwd = fixture;
          middleware = "./vendor/serve-sim/dist/middleware.js";
        }
        const result = spawnSync(
          "node",
          [
            join(import.meta.dir, "fixtures/packaged-middleware-dispatch.child.mjs"),
            resolve(cwd, middleware),
          ],
          { cwd, env: { ...process.env }, encoding: "utf8", timeout: 15_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
      } finally {
        if (fixture) rmSync(fixture, { recursive: true, force: true });
        state.restore();
      }
    },
  );

  test("the public state export uses runnable JavaScript", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    expect(pkg.exports["./state"].import).toBe("./dist/state.js");
    expect(existsSync(join(PKG_DIR, "dist/state.js"))).toBe(true);
  });

  test("the package rejects non-arm64 installations", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    expect(pkg.cpu).toEqual(["arm64"]);
  });

  test.each([...ARM64_MACH_O_ARTIFACTS])("%s is arm64-only", (artifact) => {
    const path = join(PKG_DIR, artifact);
    expect(existsSync(path)).toBe(true);
    expect(execFileSync("lipo", ["-archs", path], { encoding: "utf8" }).trim()).toBe("arm64");
  });

  test("the runtime WebRTC framework does not depend on npm-omitted symlinks", () => {
    const framework = join(PKG_DIR, "dist/bin/LiveKitWebRTC.framework");
    expect(existsSync(join(framework, "LiveKitWebRTC"))).toBe(true);
    expect(existsSync(join(framework, "Resources/PrivacyInfo.xcprivacy"))).toBe(true);
    expect(existsSync(join(framework, "Resources/LICENSE.webrtc"))).toBe(true);
    expect(existsSync(join(framework, "Versions"))).toBe(false);
  });
});
