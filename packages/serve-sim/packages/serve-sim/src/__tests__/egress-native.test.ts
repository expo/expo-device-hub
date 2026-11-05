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
const batchProbe = join(work, "sendmsg-x-probe");
const hostGuard = join(work, "host-guard.dylib");
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
  const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow"];
  run("clang", [
    ...flags,
    "-dynamiclib",
    "-DSERVE_SIM_EGRESS_HOST_TEST",
    "-DSERVE_SIM_EGRESS_TEST_REMOTE_LOOPBACK",
    join(source, "egress-guard.c"),
    join(source, "policy.c"),
    "-o",
    hostGuard,
  ]);
  run("clang", [...flags, join(source, "tests/sendmsg-x-test.c"), "-o", batchProbe]);
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

test("sendmsg_x checks every destination before submitting a batch", () => {
  const page = join(work, "batch-policy");
  run(control, ["create", page, "passthrough"]);
  expect(
    run(batchProbe, [page], {
      ...process.env,
      DYLD_INSERT_LIBRARIES: hostGuard,
      SERVE_SIM_EGRESS_POLICY_FILE: page,
    }),
  ).toContain("pointer faults passed");
});
