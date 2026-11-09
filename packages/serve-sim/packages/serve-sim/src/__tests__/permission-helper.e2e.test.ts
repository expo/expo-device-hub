import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const helper = join(import.meta.dir, "../../dist/simperm/serve-sim-permissions");
const udid = e2eDevice();
const ready = Boolean(udid && existsSync(helper));
const bundle = "dev.expo.serve-sim.helper-test";
requireE2E("native permission helper", ready);

function run(...args: string[]) {
  const result = spawnSync("xcrun", ["simctl", "spawn", udid!, helper, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe.skipIf(!ready)("native permission helper", () => {
  test("notification mutations return confirmed state and repeated reads agree", () => {
    try {
      for (const [action, status] of [
        ["grant", 2],
        ["revoke", 1],
        ["reset", 0],
      ] as const) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const changed = run("notifications", action, bundle);
          expect(changed.status, changed.stderr).toBe(0);
          const state = JSON.parse(changed.stdout);
          expect(state).toMatchObject({
            authorizationStatus: status,
            allowsNotifications: status === 2,
          });
          const read = run("notifications", "get", bundle);
          expect(read.status, read.stderr).toBe(0);
          expect(JSON.parse(read.stdout)).toEqual(state);
        }
      }
    } finally {
      const reset = run("notifications", "reset", bundle);
      expect(reset.status, reset.stderr).toBe(0);
    }
  }, 150_000);

  test("TCC accepts camera changes and rejects an unknown service", () => {
    try {
      for (const action of ["grant", "revoke", "reset"] as const) {
        const result = run("tcc", action, bundle, "", "kTCCServiceCamera");
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ ok: true });
      }
      const rejected = run("tcc", "grant", bundle, "", "kTCCServiceServeSimInvalid");
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain("TCC grant failed");
    } finally {
      const reset = run("tcc", "reset", bundle, "", "kTCCServiceCamera");
      expect(reset.status, reset.stderr).toBe(0);
    }
  }, 150_000);

  test("invalid actions and unsupported operations fail without a success reply", () => {
    for (const [args, error] of [
      [["notifications", "invalid", bundle], "Unknown permission action"],
      [["tcc", "get", bundle], "Unsupported permission operation"],
    ] as const) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(error);
    }
  }, 90_000);
});
