import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const source = join(import.meta.dir, "../../Sources/ServeSimEgressGuard");
const work = mkdtempSync("/tmp/serve-sim-egress-native-");
const control = join(work, "serve-sim-egress-control");
const probe = join(work, "serve-sim-egress-boot-identity");
const visibilityProbe = join(work, "probe-visibility");
const uid = randomUUID().toUpperCase();
const run = (path: string, args: string[], env = process.env) =>
  execFileSync(path, args, {
    encoding: "utf8",
    timeout: 20_000,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

beforeAll(() => {
  run("bash", [join(source, "build.sh"), work]);
  run("xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Dproc_listpids=eg_test_listpids",
    "-Dproc_pidinfo=eg_test_pidinfo",
    join(source, "boot-identity.c"),
    join(source, "tests/probe-visibility.c"),
    "-lproc",
    "-o",
    visibilityProbe,
  ]);
}, 30_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

test("real controller preserves the page and immutable warmup policy", () => {
  const page = join(work, "policy");
  const command = (...args: string[]) => JSON.parse(run(control, args));
  expect(command("create", page, "passthrough")).toEqual({
    publishedGeneration: 1,
    policy: "passthrough",
    warmupPolicy: "passthrough",
  });
  const inode = statSync(page).ino;
  expect(command("set", page, "block")).toEqual({
    publishedGeneration: 2,
    policy: "block",
    warmupPolicy: "passthrough",
  });
  expect(command("status", page).publishedGeneration).toBe(2);
  expect(command("set", page, "passthrough").publishedGeneration).toBe(3);
  expect(statSync(page).ino).toBe(inode);
});

test("real host probe reports no boot for an unused UUID without requiring root", () => {
  expect(run(probe, [uid]).trim()).toBe("null");
});

test("probe skips disappeared own-user processes but rejects unknown visibility", () => {
  expect(run(visibilityProbe, [uid], { ...process.env, EG_TEST_PROBE_ERROR: "ESRCH" }).trim()).toBe(
    "null",
  );
  let failure: unknown;
  try {
    run(visibilityProbe, [uid], { ...process.env, EG_TEST_PROBE_ERROR: "EPERM" });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(String((failure as { stderr: string }).stderr)).toContain("424242");
  expect(String((failure as { stderr: string }).stderr)).toContain("Operation not permitted");
});
