import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { supportsNative } from "../scripts/platform.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("package remains private and its CLI is included in the source distribution", () => {
  assert.equal(manifest.name, "@expo/emulator-capture");
  assert.equal(manifest.private, true);
  assert.ok(manifest.files.includes("src"));
  assert.ok(manifest.files.includes("dist"));
  assert.match(readFileSync(new URL(manifest.bin["emulator-capture"], root), "utf8"), /^#!\/usr\/bin\/env node/);
  assert.equal(manifest.scripts.postinstall, undefined);
});

test("native support is restricted to Linux x64", () => {
  assert.equal(supportsNative("linux", "x64"), true);
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "arm64"]])
    assert.equal(supportsNative(platform, arch), false);
});

// Exercise direct entrypoints in Bun, with no external commands on PATH.
// Platform injection is confined to these test processes.
const bun = spawnSync("bun", ["-p", "process.execPath"], { encoding: "utf8" });
assert.equal(bun.status, 0, "Bun is required to test the build scripts");
for (const platform of ["darwin", "win32"]) {
  test(`${platform} native scripts skip before downloads, compilers or FFI`, () => {
    for (const task of ["setup:build", "setup:frida", "build:ffmpeg", "build:scale", "build:native", "test:native", "benchmark"]) {
      const entry = manifest.scripts[task].slice("bun ".length);
      const script = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
        await import(${JSON.stringify(new URL(entry, root).href)});`;
      const result = spawnSync(bun.stdout.trim(), ["--eval", script], { encoding: "utf8", env: { ...process.env, PATH: "" } });
      assert.equal(result.status, 0, `${task}: ${result.stderr}`);
      assert.ok(result.stderr.includes(`WARNING: ${task} skipped`), result.stderr);
      assert.match(result.stderr, /No Linux artifacts were produced/);
    }
  });
  test(`${platform} capture fails explicitly instead of claiming to work`, () => {
    const script = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      await import(${JSON.stringify(new URL("src/cli.mjs", root).href)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Capture requires Linux x64/);
  });
}
