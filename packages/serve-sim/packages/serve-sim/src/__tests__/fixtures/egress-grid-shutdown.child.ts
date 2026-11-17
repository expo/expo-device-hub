import { expect, mock, test } from "bun:test";
import * as sessions from "../../device-session";
import * as simctl from "../../simctl";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeLaunchState } from "../../launch-state";
import { useTempStateDir } from "../helpers";

test("resident grid shutdown rejects before closing capture or running a command", async () => {
  const state = useTempStateDir();
  const udid = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  mock.module("../../device-session", () => ({
    ...sessions,
    retireDeviceSession: async () => {
      calls.push("close");
    },
  }));
  mock.module("../../simctl", () => ({
    ...simctl,
    simctl: async () => {
      calls.push("exec");
      throw new Error("Native commands disabled in this fixture");
    },
  }));
  let middleware: ReturnType<typeof import("../../middleware").simMiddleware> | undefined;
  try {
    writeLaunchState(udid, {
      launchArgs: [],
      capabilities: {
        egressGuard: {
          name: "egressGuard",
          dylib: "/resident/guard.dylib",
          env: { SERVE_SIM_EGRESS_POLICY_FILE: "/resident/policy" },
          scope: "allProcesses",
          loadPhase: "startup",
          ownerPid: null,
          bundleId: null,
          resident: { boot: { pid: 123, startedAt: "1720000000:42" }, warmupPolicy: "block" },
        },
      },
    });
    const launchFile = join(state.dir, `launch-${udid}.json`);
    const before = readFileSync(launchFile, "utf8");
    const { simMiddleware } = await import("../../middleware");
    middleware = simMiddleware({ execToken: "grid-test-token", requirePreviewToken: true });
    const response = await middleware(
      new Request("http://localhost/.sim/grid/api/shutdown", {
        method: "POST",
        headers: { Authorization: "Bearer grid-test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ udid }),
      }),
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      ok: false,
      error:
        "Simulator shutdown is unavailable while resident egress is enrolled; preserve its boot and guard.",
    });
    expect(calls).toEqual([]);
    expect(readFileSync(launchFile, "utf8")).toBe(before);

    // An ordinary device still reaches session cleanup and the shutdown command.
    unlinkSync(launchFile);
    const ordinary = await middleware(
      new Request("http://localhost/.sim/grid/api/shutdown", {
        method: "POST",
        headers: { Authorization: "Bearer grid-test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ udid }),
      }),
    );
    expect(ordinary?.status).toBe(500);
    expect(await ordinary?.json()).toMatchObject({
      error: "Native commands disabled in this fixture",
    });
    expect(calls).toEqual(["close", "exec"]);
  } finally {
    await middleware?.dispose?.();
    mock.restore();
    state.restore();
  }
});
