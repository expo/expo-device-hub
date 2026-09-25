import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";

import {
  type RecordedCapability,
  MAX_CONFIG_BYTES,
  childLaunchEnv,
  clearLaunchState,
  formatCapabilityConfig,
  isCapabilityEnabled,
  listCapabilities,
  readLaunchState,
  releaseLaunchState,
  releaseSessionSync,
  releaseSession,
  stopLaunchSession,
  enableCapabilities,
  setCapabilityEnabled,
  applyDefaultCapabilities,
  armCapabilityLoader,
  capabilityConfigPath,
  capabilityLoaderPath,
  renderCapabilityConfig,
} from "../launch-manager";
import { registerCapability, clearRegisteredCapabilities } from "../capabilities";
import { launchAppAsync } from "../launch-app";
import { stateDir } from "../state";
import { useTempStateDir, withShimsAsync } from "./helpers";
import { requireE2E } from "./e2e-preconditions";

const UDID = "LAUNCH-MANAGER-TEST-" + process.pid;

let tempState: { dir: string; restore(): void };

beforeAll(() => {
  tempState = useTempStateDir();
});

afterAll(() => {
  tempState.restore();
});

function writeRawState(contents: string): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), `launch-${UDID}.json`), contents);
}

afterEach(() => {
  clearLaunchState(UDID);
  try { unlinkSync(capabilityConfigPath(UDID)); } catch {}
});

describe("formatCapabilityConfig", () => {
  test("writes one tab-separated line per capability", () => {
    expect(
      formatCapabilityConfig({
        camera: {
          name: "camera",
          bundleId: "host.exp.Exponent",
          scope: "allApps",
          dylib: "/dist/simcam/libSimCameraInjector.dylib",
          ownerPid: null,
          loadDelayMs: 500,
          env: { SIMCAM_SHM_NAME: "/serve-sim-cam-1", SIMCAM_MIRROR_MODE: "on" },
        },
      }),
    ).toBe(
      "all\t/dist/simcam/libSimCameraInjector.dylib" +
        "\tSIMCAM_SHM_NAME=/serve-sim-cam-1;SIMCAM_MIRROR_MODE=on\t500\n",
    );
  });

  test("keeps every capability so enabling one never evicts another", () => {
    const config = formatCapabilityConfig({
      camera: {
        name: "camera",
        bundleId: "a",
        scope: "allApps",
        dylib: "/cam.dylib",
        ownerPid: null,
        loadDelayMs: 500,
      },
      fps: { name: "fps", bundleId: "a", scope: "allApps", dylib: "/fps.dylib", env: { SERVE_SIM_FPS_FILE: "/f" }, ownerPid: null },
    });
    expect(config.trim().split("\n")).toEqual([
      "all\t/cam.dylib\t\t500",
      "all\t/fps.dylib\tSERVE_SIM_FPS_FILE=/f\t0",
    ]);
  });

  test("is empty when nothing is enabled", () => {
    expect(formatCapabilityConfig({})).toBe("");
  });
});

describe("readLaunchState", () => {
  test("returns null when nothing was recorded", () => {
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("reads the bundle, its arguments and its capabilities", () => {
    writeRawState(
      JSON.stringify({
        bundleId: "host.exp.Exponent",
        launchArgs: ["-EXDevMenuIsOnboardingFinished", "1"],
        capabilities: {
          "host.exp.Exponent:camera": {
            name: "camera",
            bundleId: "host.exp.Exponent",
            scope: "allApps",
            dylib: "/cam.dylib",
            ownerPid: null,
          },
        },
      }),
    );
    const state = readLaunchState(UDID);
    expect(state?.bundleId).toBe("host.exp.Exponent");
    expect(state?.launchArgs).toEqual(["-EXDevMenuIsOnboardingFinished", "1"]);
    expect(Object.keys(state?.capabilities ?? {})).toEqual(["host.exp.Exponent:camera"]);
  });

  test("defaults the arguments and capabilities when they are absent", () => {
    writeRawState(JSON.stringify({ bundleId: "host.exp.Exponent" }));
    expect(readLaunchState(UDID)).toEqual({
      bundleId: "host.exp.Exponent",
      launchArgs: [],
      capabilities: {},
    });
  });

  test("returns null for a file that is not JSON", () => {
    writeRawState("not json");
    expect(readLaunchState(UDID)).toBeNull();
  });
});

describe("config size limit", () => {
  const huge: Record<string, RecordedCapability> = {
    huge: {
      name: "huge",
      bundleId: "a",
      scope: "allApps",
      dylib: "/huge.dylib",
      ownerPid: null,
      env: { BIG: "x".repeat(70_000) },
    },
  };

  test("a capability set that would not fit is refused", () => {
    expect(() =>
      renderCapabilityConfig({ launchArgs: [], capabilities: huge }),
    ).toThrow("The capability loader would load nothing");
  });

  test("a capability set that fits is rendered", () => {
    expect(
      renderCapabilityConfig({
        launchArgs: [],
        capabilities: {
          small: {
            name: "small",
            bundleId: "a",
            scope: "allApps",
            dylib: "/small.dylib",
            ownerPid: null,
          },
        },
      }),
    ).toBe("all\t/small.dylib\t\t0\n");
  });

  test("refuses a config the capability loader could not read", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../Sources/ServeSimCapabilityLoader/serve-sim-capability-loader.c"),
      "utf-8",
    );
    const compiled = source.match(/#define MAX_CONFIG_BYTES \((\d+) \* (\d+)\)/);
    expect(compiled).not.toBeNull();
    expect(Number(compiled![1]) * Number(compiled![2])).toBe(MAX_CONFIG_BYTES);
  });
});

describe("config field separators", () => {
  test("a value carrying a separator is refused", () => {
    for (const value of ["a\tb", "a\nb", "a;b"]) {
      expect(() =>
        formatCapabilityConfig({
          "x": { name: "x", bundleId: "a", scope: "allApps", dylib: "/x.dylib", env: { K: value }, ownerPid: null },
        }),
      ).toThrow("separates fields");
    }
  });

  test("a name carrying the pair separator is refused", () => {
    expect(() =>
      formatCapabilityConfig({
        "x": { name: "x", bundleId: "a", scope: "allApps", dylib: "/x.dylib", env: { "K=V": "1" }, ownerPid: null },
      }),
    ).toThrow('contains "="');
  });
});

describe("querying what is enabled", () => {
  test("reports the capabilities recorded for the device", () => {
    writeRawState(
      JSON.stringify({
        bundleId: "host.exp.Exponent",
        launchArgs: [],
        capabilities: {
          camera: {
            name: "camera",
            bundleId: "host.exp.Exponent",
            scope: "allApps",
            dylib: "/cam.dylib",
            ownerPid: null,
          },
          capture: {
            name: "capture",
            bundleId: null,
            scope: "userApps",
            dylib: "/cap.dylib",
            ownerPid: null,
          },
        },
      }),
    );
    expect(isCapabilityEnabled(UDID, "camera")).toBe(true);
    expect(isCapabilityEnabled(UDID, "clipboard")).toBe(false);
    expect(listCapabilities(UDID)).toEqual(["camera", "capture"]);
  });

  test("reports nothing for a device with no recorded state", () => {
    expect(isCapabilityEnabled(UDID, "camera")).toBe(false);
    expect(listCapabilities(UDID)).toEqual([]);
  });
});

describe("capability scopes", () => {
  test("each scope writes the token the capability loader matches on", () => {
    const config = formatCapabilityConfig({
      clipboard: {
        name: "clipboard",
        bundleId: null,
        scope: "allApps",
        dylib: "/reader.dylib",
        ownerPid: null,
      },
      capture: {
        name: "capture",
        bundleId: null,
        scope: "userApps",
        dylib: "/cap.dylib",
        ownerPid: null,
        loadDelayMs: 250,
      },
    });
    expect(config.split("\n").filter(Boolean)).toEqual([
      "all\t/reader.dylib\t\t0",
      "user\t/cap.dylib\t\t250",
    ]);
  });

  test("a record with an unreadable scope is dropped", () => {
    writeRawState(
      JSON.stringify({
        launchArgs: [],
        capabilities: {
          camera: { name: "camera", bundleId: null, scope: "everything", dylib: "/cam.dylib", ownerPid: null },
        },
      }),
    );
    expect(listCapabilities(UDID)).toEqual([]);
  });
});

describe("state without a launched app", () => {
  test("is readable, so capabilities can exist before anything is launched", () => {
    writeRawState(JSON.stringify({ launchArgs: [], capabilities: {} }));
    expect(readLaunchState(UDID)).toEqual({ launchArgs: [], capabilities: {} });
  });
});

describe("releaseLaunchState", () => {
  const record = (ownerPid: number | null) => ({
    name: "probe",
    bundleId: "a",
    scope: "allApps",
    dylib: "/probe.dylib",
    ownerPid,
  });

  test("keeps a record another live session owns", () => {
    writeRawState(
      JSON.stringify({
        launchArgs: [],
        capabilities: { probe: record(process.pid), other: { ...record(process.ppid), name: "other" } },
      }),
    );

    expect(releaseLaunchState(UDID, process.pid)).toBe(true);
    expect(listCapabilities(UDID)).toEqual(["other"]);
  });

  test("reports nothing left when only our records were there", () => {
    writeRawState(
      JSON.stringify({ launchArgs: [], capabilities: { probe: record(process.pid) } }),
    );

    expect(releaseLaunchState(UDID, process.pid)).toBe(false);
    expect(readLaunchState(UDID)).toBeNull();
  });

  test("keeps a record no session owns, so a one-shot command survives", () => {
    writeRawState(
      JSON.stringify({ launchArgs: [], capabilities: { probe: record(null) } }),
    );

    expect(releaseLaunchState(UDID, process.pid)).toBe(true);
    expect(listCapabilities(UDID)).toEqual(["probe"]);
  });

  test("drops a record whose owner died without disarming", () => {
    const dead = 999_999;
    writeRawState(
      JSON.stringify({ launchArgs: [], capabilities: { probe: record(dead) } }),
    );

    expect(listCapabilities(UDID)).toEqual([]);
  });
});


describe("session cleanup", () => {
  test("keeps another armed session even with no capabilities", () => {
    writeRawState(JSON.stringify({
      launchArgs: [], capabilities: {}, sessionPids: [process.pid, process.ppid],
    }));
    expect(releaseLaunchState(UDID, process.pid)).toBe(true);
    expect(readLaunchState(UDID)?.sessionPids).toEqual([process.ppid]);
    expect(listCapabilities(UDID)).toEqual([]);
  });

  test("releases only our host resources and preserves persistent capabilities", () => {
    const capability = (name: string, ownerPid: number | null) => ({
      name, ownerPid, bundleId: null, scope: "allApps", dylib: "/probe.dylib",
    });
    writeRawState(JSON.stringify({
      launchArgs: [], sessionPids: [process.pid, process.ppid],
      capabilities: {
        ours: capability("ours", process.pid),
        theirs: capability("theirs", process.ppid),
        persistent: capability("persistent", null),
      },
    }));
    const released: string[] = [];
    releaseSessionSync(UDID, process.pid, (record) => released.push(record.name));
    expect(released).toEqual(["ours"]);
    expect(listCapabilities(UDID)).toEqual(["persistent", "theirs"]);
  });

  test("does not deadlock exit cleanup against its own active update", () => {
    const lock = join(stateDir(), `launch-${UDID}.lock`);
    writeRawState(JSON.stringify({ launchArgs: [], capabilities: {} }));
    writeFileSync(lock, String(process.pid));
    try {
      expect(() => releaseLaunchState(UDID, process.pid)).toThrow("while this process is updating");
      expect(readLaunchState(UDID)).not.toBeNull();
    } finally {
      unlinkSync(lock);
    }
  });

  test("waits for a concurrent update before deciding what to release", async () => {
    const lock = join(stateDir(), `launch-${UDID}.lock`);
    const target = join(stateDir(), `launch-${UDID}.json`);
    const ready = join(stateDir(), "cleanup-lock-ready");
    writeRawState(JSON.stringify({ launchArgs: [], capabilities: {
      sentinel: { name: "sentinel", scope: "allApps", dylib: "/probe.dylib", ownerPid: null },
    } }));
    const script = `
      const fs = require("fs");
      fs.writeFileSync(${JSON.stringify(lock)}, String(process.pid), { flag: "wx" });
      fs.writeFileSync(${JSON.stringify(ready)}, "ready");
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(target)}, JSON.stringify({
          launchArgs: [], capabilities: { camera: {
            name: "camera", scope: "allApps", dylib: "/camera.dylib", ownerPid: null,
          } },
        }));
        fs.unlinkSync(${JSON.stringify(lock)});
      }, 300);
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
    });
    const deadline = Date.now() + 3000;
    while (!existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      expect(existsSync(ready)).toBe(true);
      releaseSessionSync(UDID, process.pid, () => {});
      expect(listCapabilities(UDID)).toEqual(["camera"]);
      await exited;
    } finally {
      child.kill();
    }
  });
});


describe("graceful launch shutdown", () => {
  test("awaits an active launch transaction before releasing its capabilities", async () => {
    writeRawState(JSON.stringify({ launchArgs: [], capabilities: {}, sessionPids: [process.ppid] }));
    await withShimsAsync({ xcrun: "#!/bin/sh\nsleep 0.15\nexit 0\n" }, async () => {
      const released: string[] = [];
      const update = enableCapabilities(UDID, null, [{
        name: "camera", scope: "allApps", dylib: "/camera.dylib",
      }], { relaunch: false });
      const shutdown = releaseSession(UDID, process.pid, (record) => released.push(record.name));
      await Promise.all([update, shutdown]);
      expect(released).toEqual(["camera"]);
      expect(listCapabilities(UDID)).toEqual([]);
      expect(readLaunchState(UDID)?.sessionPids).toEqual([process.ppid]);
    });
  });

  test("--kill waits for owner cleanup and preserves another live session", async () => {
    const marker = join(stateDir(), "owner-cleaned");
    const manager = join(import.meta.dir, "../launch-manager.ts");
    const child = spawn(process.execPath, ["-e", `
      const { releaseSessionSync } = await import(${JSON.stringify(manager)});
      const fs = require("fs");
      process.on("SIGTERM", () => setTimeout(() => {
        releaseSessionSync(${JSON.stringify(UDID)}, process.pid, (record) => {
          fs.writeFileSync(${JSON.stringify(marker)}, record.name);
        });
        process.exit(0);
      }, 100));
      setInterval(() => {}, 1000);
      console.log("ready");
    `], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout?.once("data", () => resolve());
      });
      writeRawState(JSON.stringify({
        launchArgs: [], sessionPids: [child.pid, process.pid],
        capabilities: { camera: { name: "camera", scope: "allApps", dylib: "/camera.dylib", ownerPid: child.pid } },
      }));
      const fallback: string[] = [];
      await stopLaunchSession(UDID, child.pid!, (record) => fallback.push(record.name));
      expect(readFileSync(marker, "utf-8")).toBe("camera");
      expect(fallback).toEqual([]);
      expect(readLaunchState(UDID)?.sessionPids).toEqual([process.pid]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("--kill releases a dead owner's resources without removing persistent ones", async () => {
    const dead = 999_999;
    writeRawState(JSON.stringify({
      launchArgs: [], sessionPids: [process.pid],
      capabilities: {
        camera: { name: "camera", scope: "allApps", dylib: "/camera.dylib", ownerPid: dead },
        probe: { name: "probe", scope: "allApps", dylib: "/probe.dylib", ownerPid: null },
      },
    }));
    const released: string[] = [];
    await stopLaunchSession(UDID, dead, (record) => released.push(record.name));
    expect(released).toEqual(["camera"]);
    expect(listCapabilities(UDID)).toEqual(["probe"]);
    expect(readLaunchState(UDID)?.sessionPids).toEqual([process.pid]);
  });
});


describe("startup capability loading", () => {
  test("can enable a definition without registering it globally", async () => {
    clearRegisteredCapabilities();
    await withShimsAsync({ xcrun: "#!/bin/sh\nexit 0\n" }, async () => {
      await setCapabilityEnabled(UDID, {
        name: "clipboard",
        defaultEnabled: true,
        scope: "allApps",
        async setEnabled() {
          return { dylib: "/clipboard.dylib" };
        },
      }, { enabled: true, relaunch: false });
    });
    expect(listCapabilities(UDID)).toEqual(["clipboard"]);
  });

  test("reuses another live owner's clipboard capability", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeRawState(JSON.stringify({
        launchArgs: [],
        capabilities: {
          clipboard: {
            name: "clipboard", scope: "allApps", dylib: "/other-reader.dylib",
            bundleId: null, ownerPid: owner.pid,
          },
        },
      }));
      await withShimsAsync({ xcrun: "#!/bin/sh\nexit 0\n" }, async () => {
        await setCapabilityEnabled(UDID, {
          name: "clipboard", defaultEnabled: true, scope: "allApps",
          async setEnabled() { return { dylib: "/this-reader.dylib" }; },
        }, { enabled: true, relaunch: false, reuseIfEnabled: true });
      });
      expect(readLaunchState(UDID)?.capabilities.clipboard).toMatchObject({
        ownerPid: owner.pid,
        dylib: "/other-reader.dylib",
      });
      releaseSessionSync(UDID, process.pid, () => {});
      expect(readLaunchState(UDID)?.capabilities.clipboard?.ownerPid).toBe(owner.pid);
    } finally {
      owner.kill("SIGKILL");
    }
  });

  test("defaults do not restart a remembered app and explicit launch starts once", async () => {
    const log = join(stateDir(), "simctl-startup-calls");
    const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'";
    clearRegisteredCapabilities();
    registerCapability({ name: "camera", defaultEnabled: false, scope: "allApps", async setEnabled() {
      return { dylib: "/camera.dylib" };
    } });
    try {
      await withShimsAsync({ xcrun: `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quotedLog}\nexit 0\n` }, async () => {
        writeRawState(JSON.stringify({ bundleId: "remembered.app", launchArgs: [], capabilities: {} }));
        await applyDefaultCapabilities(UDID, null, { enable: ["camera"] });
        const calls = () => readFileSync(log, "utf-8").split("\n");
        expect(calls().filter((line) => /^simctl (launch|terminate) /.test(line))).toEqual([]);
        await launchAppAsync(UDID, { bundleId: "explicit.app", launchArgs: [], capabilities: { enable: ["camera"] } });
        expect(calls().filter((line) => line.startsWith("simctl launch "))).toEqual([`simctl launch ${UDID} explicit.app`]);
        expect(calls().filter((line) => line.startsWith("simctl terminate "))).toEqual([`simctl terminate ${UDID} explicit.app`]);
      });
    } finally {
      clearRegisteredCapabilities();
    }
  });

  test("publishes a capability before launching so the app cannot start without it", async () => {
    const log = join(stateDir(), "simctl-order-calls");
    const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'";
    const quotedConfig = "'" + capabilityConfigPath(UDID).replaceAll("'", "'\\''") + "'";
    clearRegisteredCapabilities();
    registerCapability({ name: "camera", defaultEnabled: false, scope: "allApps", async setEnabled() {
      return { dylib: "/camera.dylib" };
    } });
    try {
      await withShimsAsync({ xcrun: `#!/bin/sh
printf '%s\\n' "$*" >> ${quotedLog}
if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then
  printf 'config-at-launch:%s\\n' "$(tr '\\t\\n' '  ' < ${quotedConfig} 2>/dev/null)" >> ${quotedLog}
fi
exit 0
` }, async () => {
        writeRawState(JSON.stringify({ launchArgs: [], capabilities: {} }));
        await launchAppAsync(UDID, {
          bundleId: "explicit.app",
          launchArgs: [],
          capabilities: { enable: ["camera"] },
        });
        const calls = readFileSync(log, "utf-8").split("\n");
        expect(calls.find((line) => line.startsWith("config-at-launch:"))).toContain("/camera.dylib");
      });
    } finally {
      clearRegisteredCapabilities();
    }
  });
});

const loaderBuilt = existsSync(capabilityLoaderPath());

requireE2E("capability loader arming", loaderBuilt);

describe.skipIf(!loaderBuilt)("armCapabilityLoader", () => {
  test("republishes the config before arming so a dead session's capability cannot load", async () => {
    const log = join(stateDir(), "simctl-arm-calls");
    const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'";
    const quotedConfig = "'" + capabilityConfigPath(UDID).replaceAll("'", "'\\''") + "'";
    const dead = 999_999;
    writeRawState(JSON.stringify({
      launchArgs: [], sessionPids: [],
      capabilities: {
        camera: { name: "camera", scope: "allApps", dylib: "/camera.dylib", ownerPid: dead },
        probe: { name: "probe", scope: "allApps", dylib: "/probe.dylib", ownerPid: null },
        live: { name: "live", scope: "allApps", dylib: "/live.dylib", ownerPid: process.pid },
      },
    }));
    writeFileSync(
      capabilityConfigPath(UDID),
      "all\t/camera.dylib\t\t0\nall\t/probe.dylib\t\t0\nall\t/live.dylib\t\t0\n",
    );

    await withShimsAsync({ xcrun: `#!/bin/sh
printf '%s\\n' "$*" >> ${quotedLog}
if [ "$5" = "setenv" ] && [ "$6" = "DYLD_INSERT_LIBRARIES" ]; then
  printf 'config-at-arm:%s\\n' "$(cat ${quotedConfig} 2>/dev/null | tr '\\t\\n' '  ')" >> ${quotedLog}
fi
exit 0
` }, async () => {
      await armCapabilityLoader(UDID);
    });

    const atArm = readFileSync(log, "utf-8").split("\n").find((line) => line.startsWith("config-at-arm:"));
    expect(atArm).toContain("/probe.dylib");
    expect(atArm).toContain("/live.dylib");
    expect(atArm).not.toContain("/camera.dylib");
    expect(readFileSync(capabilityConfigPath(UDID), "utf-8")).toBe(
      "all\t/probe.dylib\t\t0\nall\t/live.dylib\t\t0\n",
    );
  });
});

describe("childLaunchEnv", () => {
  test("inserts the capability dylib and the capability loader into the launched app", () => {
    const env = childLaunchEnv("/opt/injector.dylib", { SIMCAM_SHM_NAME: "/shm" });
    const inserted = env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES!.split(":");

    expect(inserted).toContain("/opt/injector.dylib");
    expect(inserted.some((path) => path.endsWith("libServeSimCapabilityLoader.dylib"))).toBe(true);
  });

  test("prefixes the capability environment so simctl passes it to the app", () => {
    expect(childLaunchEnv("/opt/injector.dylib", { SIMCAM_SHM_NAME: "/shm" })).toMatchObject({
      SIMCTL_CHILD_SIMCAM_SHM_NAME: "/shm",
    });
  });
});
