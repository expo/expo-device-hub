import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { useTempStateDir, withShimsAsync } from "../helpers";
import { writeLaunchState } from "../../launch-state";

const work = mkdtempSync("/tmp/serve-sim-egress-cli-");
const udid = "11111111-1111-4111-8111-111111111111";
let cli: string;
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../index.ts")],
    target: "node",
    outdir: join(work, "cli"),
    naming: "[name].mjs",
  });
  if (!result.success) throw new AggregateError(result.logs, "CLI test fixture bundle failed");
  cli = result.outputs[0]!.path;
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
  commandOrDevice = udid,
) {
  const child = Bun.spawn(["node", cli, commandOrDevice, ...args, "--quiet"], {
    env: { ...process.env, SERVE_SIM_STREAM_HELPER: undefined, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
}
function refuseNative(log: string): string {
  return `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, 'called\\n');process.exit(99);\n`;
}
test("camera refuses resident enrollment before obtaining artifacts or touching the device", async () => {
  const state = useTempStateDir(),
    log = join(state.dir, "native-calls");
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
    await withShimsAsync({ xcrun: refuseNative(log) }, async () => {
      const result = await runCli(["com.test.app", "-d", udid], {}, "camera");
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error).toBe(
        "Camera app launch is unavailable while resident egress is enrolled; preserve its boot and guard.",
      );
      expect(existsSync(log)).toBe(false);
    });
  } finally {
    state.restore();
  }
});
for (const flag of ["--enable", "--disable"]) {
  test(`${flag} egressGuard is a required path, not best effort`, async () => {
    const state = useTempStateDir(),
      log = join(state.dir, "native-calls");
    try {
      await withShimsAsync({ xcrun: refuseNative(log) }, async () => {
        const result = await runCli([
          flag,
          "egressGuard",
          "--launch-app-identifier",
          "com.test.app",
        ]);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout).error).toContain("serve-sim-egress-boot-identity ENOENT");
        expect(result.stderr).not.toContain("simulator-boot");
        expect(result.stdout).not.toContain('"url"');
        expect(existsSync(log)).toBe(false);
      });
    } finally {
      state.restore();
    }
  });
  test(`stream helper cannot request policy with ${flag}`, async () => {
    const state = useTempStateDir(),
      log = join(state.dir, "native-calls");
    try {
      await withShimsAsync({ xcrun: refuseNative(log) }, async () => {
        const result = await runCli([flag, "egressGuard"], { SERVE_SIM_STREAM_HELPER: "1" });
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout).error).toContain(
          "Stream helpers cannot request egress policy",
        );
        expect(existsSync(log)).toBe(false);
      });
    } finally {
      state.restore();
    }
  });
}
test("conflicting egress choices reject before device operations", async () => {
  const state = useTempStateDir();
  try {
    const result = await runCli(["--enable", "egressGuard", "--disable", "egressGuard"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("not both");
  } finally {
    state.restore();
  }
});
test("no egress request retains the ordinary startup path", async () => {
  const state = useTempStateDir(),
    log = join(state.dir, "native-calls");
  try {
    await withShimsAsync({ xcrun: refuseNative(log) }, async () => {
      const result = await runCli([]);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("egress enforcement is unavailable");
      expect(existsSync(log)).toBe(true);
    });
  } finally {
    state.restore();
  }
});

test("resident policy rejects the full multi-device orphan list before any boot", async () => {
  const result = await runCli([
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    "--orphan",
    "--require-token",
    "--transport",
    "webrtc",
    "--disable",
    "egressGuard",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toBe("Resident egress requires one exact Simulator UDID");
  expect(result.stderr).not.toContain('"phase":"simulator-boot"');
});
