import { expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { freePortAsync } from "./helpers";

// Destructive opt-in: reboots the simulator and restarts BackBoard. Use only
// a dedicated, booted iOS 27 iPhone, never an automatically selected device.
// SERVE_SIM_TEST_UDID=... SERVE_SIM_HID_OWNERSHIP_E2E=1 bun run test:e2e -- \
//   packages/serve-sim/src/__tests__/hid-ownership.e2e.test.ts
const enabled = process.env.SERVE_SIM_HID_OWNERSHIP_E2E === "1";
const CLI = join(import.meta.dir, "../../dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const OWNER = "com.apple.coredevice.dtuhidd.active";

function simctl(...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: args[0] === "bootstatus" ? 180_000 : 60_000,
  });
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(250);
  }
  throw new Error(message);
}

test
  .skipIf(!enabled)
  .each(["native", "native-no-keyboard", "native-no-screen", "preview"] as const)(
  "ordinary iPhone %s input reaches UIKit with CoreDevice HID ownership",
  async (transport) => {
    const udid = process.env.SERVE_SIM_TEST_UDID?.trim();
    if (!udid) throw new Error("set SERVE_SIM_TEST_UDID to a dedicated iOS 27 iPhone");
    const listing = JSON.parse(simctl("list", "devices", "booted", "-j")) as {
      devices: Record<string, { udid: string; deviceTypeIdentifier: string }[]>;
    };
    expect(
      Object.entries(listing.devices).some(
        ([runtime, devices]) =>
          runtime.includes("iOS-27") &&
          devices.some(
            (device) =>
              device.udid === udid &&
              device.deviceTypeIdentifier.includes("iPhone") &&
              !device.deviceTypeIdentifier.includes("Duo"),
          ),
      ),
      "requires a booted ordinary iOS 27 iPhone",
    ).toBe(true);

    const stateDir = mkdtempSync(join(tmpdir(), "serve-sim-hid-ownership-"));
    const nativeEnv = { ...process.env };
    let server: ChildProcess | undefined;
    const serverLog = join(stateDir, "foreground.log");
    const serverExited = () => server?.exitCode != null || server?.signalCode != null;
    let fixtureLog = "";
    const lines = () => {
      try {
        return readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    const restartBackBoard = async (owner: number) => {
      simctl("spawn", udid, "notifyutil", "-s", OWNER, String(owner));
      simctl("spawn", udid, "notifyutil", "-p", OWNER);
      await Bun.sleep(500);
      simctl("spawn", udid, "launchctl", "kickstart", "-k", "user/foreground/com.apple.backboardd");
      await Bun.sleep(3_000);
    };
    const launchFixture = async () => {
      const start = lines().length;
      try {
        simctl("terminate", udid, APP);
      } catch {}
      simctl("launch", udid, APP, "--input-test");
      await waitFor(
        () =>
          lines()
            .slice(start)
            .some((line) => line.startsWith("input-ready\t")),
        "fixture never became ready",
      );
    };
    const nativeInput = (input: string) => {
      const output = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `
      import { createRequire } from 'node:module';
      import assert from 'node:assert/strict';
      const { SimHID } = createRequire(import.meta.url)(process.argv[1]);
      const hid = new SimHID(process.argv[2]);
      const keyboardAvailable = await hid.setScreen(${transport === "native-no-screen" ? 0 : 1});
      ${transport === "native-no-keyboard" ? "assert.equal(keyboardAvailable, false);" : ""}
      ${input}
      await new Promise(resolve => setTimeout(resolve, 150));
      process.exit(0);
    `,
          join(import.meta.dir, "../../dist/native/serve-sim-native.node"),
          udid,
        ],
        {
          env: nativeEnv,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 30_000,
        },
      );
      appendFileSync(serverLog, output);
      if (transport === "native-no-keyboard")
        expect(output).toContain("[test] CoreDevice keyboard symbol hidden");
    };
    const startServer = async () => {
      // Same foreground startup and input path as build-tools createServeSimArgs;
      // tunnel, reporting, and hosted-worker execution are intentionally absent.
      const fd = openSync(serverLog, "a");
      try {
        server = spawn(
          "node",
          [
            CLI,
            udid,
            "--port",
            String(await freePortAsync()),
            "--host",
            "127.0.0.1",
            "--require-token",
            "--transport",
            "webrtc",
            "--webrtc-codec",
            "h264",
            "--disable-share",
          ],
          {
            env: { ...nativeEnv, SERVE_SIM_STATE_DIR: stateDir, SERVE_SIM_DEBUG_HID: "1" },
            stdio: ["ignore", fd, fd],
          },
        );
      } finally {
        closeSync(fd);
      }
      await waitFor(
        () => {
          if (serverExited())
            throw new Error(`server exited: ${server?.signalCode ?? server?.exitCode}`);
          return existsSync(join(stateDir, `server-${udid}.json`));
        },
        "foreground server never became ready",
        90_000,
      );
    };
    const tapFixture = async (label: string) => {
      const start = lines().length;
      const received = () =>
        waitFor(() => {
          const fresh = lines().slice(start);
          return (
            fresh.some((line) => line.startsWith("touch-began\t")) &&
            fresh.some((line) => line.startsWith("touch-ended\t"))
          );
        }, `${label}: serve-sim touch never reached UIKit`);
      if (transport !== "preview") {
        // Exercise HID setup independently of capture's CoreDevice observers.
        // A successful native completion alone is not proof of guest delivery.
        nativeInput(`
        await hid.touch('begin', .5, .5, 1170, 2532, 0);
        await new Promise(resolve => setTimeout(resolve, 150));
        await hid.touch('end', .5, .5, 1170, 2532, 0);
      `);
        await received();
      } else {
        const state = JSON.parse(readFileSync(join(stateDir, `server-${udid}.json`), "utf8")) as {
          wsUrl: string;
          token: string;
        };
        const ws = new WebSocket(state.wsUrl, {
          headers: { Authorization: `Bearer ${state.token}` },
        });
        ws.binaryType = "arraybuffer";
        let inputConfig: { keyboardUnavailable?: boolean; inputUnavailable?: boolean } | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            let configured = false;
            let admitted = false;
            const timer = setTimeout(() => reject(new Error("input socket timed out")), 15_000);
            ws.on("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            ws.on("message", (raw: ArrayBuffer) => {
              const data = new Uint8Array(raw);
              if (data[0] === 0x82) {
                inputConfig = JSON.parse(Buffer.from(data.subarray(1)).toString());
                configured = true;
              }
              if (data[0] === 0x83) admitted = true;
              if (configured && admitted) {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          expect(inputConfig).toMatchObject({ keyboardUnavailable: true, inputUnavailable: false });
          for (const type of ["begin", "end"]) {
            ws.send(
              Buffer.concat([
                Buffer.from([3]),
                Buffer.from(JSON.stringify({ type, x: 0.5, y: 0.5 })),
              ]),
            );
            await Bun.sleep(150);
          }
          await received();
          const acknowledgement = new Promise<Uint8Array>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("key failure acknowledgement timed out")),
              15_000,
            );
            ws.on("message", (raw: ArrayBuffer) => {
              const data = new Uint8Array(raw);
              if (data[0] === 0x91) {
                clearTimeout(timer);
                resolve(data);
              }
            });
          });
          ws.send(
            Buffer.concat([
              Buffer.from([6]),
              Buffer.from(JSON.stringify({ type: "down", usage: 4 })),
            ]),
          );
          ws.send(Buffer.from([0x11]));
          expect([...(await acknowledgement)]).toEqual([0x91, 0]);
        } finally {
          ws.close();
        }
      }
    };
    try {
      if (transport === "native-no-keyboard" || transport === "preview") {
        const library = join(stateDir, "no-keyboard.dylib");
        execFileSync(
          "xcrun",
          [
            "clang",
            "-dynamiclib",
            "-arch",
            "arm64",
            "-o",
            library,
            join(import.meta.dir, "fixtures/hid-no-keyboard.c"),
          ],
          { stdio: "pipe", timeout: 30_000 },
        );
        nativeEnv.DYLD_INSERT_LIBRARIES = [library, nativeEnv.DYLD_INSERT_LIBRARIES]
          .filter(Boolean)
          .join(":");
      }
      // CoreDevice connections from an earlier test can keep guest HID services
      // alive after their host client exits. Start from a fresh guest boot.
      simctl("shutdown", udid);
      simctl("boot", udid);
      simctl("bootstatus", udid, "-b");
      simctl("install", udid, FIXTURE);
      fixtureLog = join(
        simctl("get_app_container", udid, APP, "data").trim(),
        "Documents/launches.tsv",
      );
      await restartBackBoard(0);
      if (transport === "preview") await startServer();
      await launchFixture();
      await tapFixture("legacy-mode control");
      await restartBackBoard(1);
      await launchFixture();
      // dtuhidd can clear its notification during startup. Reassert the active
      // owner after the fixture is ready, matching Device Hub ownership.
      simctl("spawn", udid, "notifyutil", "-s", OWNER, "1");
      simctl("spawn", udid, "notifyutil", "-p", OWNER);
      await Bun.sleep(500);
      await tapFixture("CoreDevice-owned startup");
      await tapFixture("second touch");
      if (transport === "preview") {
        const state = JSON.parse(readFileSync(join(stateDir, `server-${udid}.json`), "utf8")) as {
          url: string;
          token: string;
        };
        for (const action of ["shutdown", "start"]) {
          const response = await fetch(`${state.url}/grid/api/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
            body: JSON.stringify({ udid }),
            signal: AbortSignal.timeout(190_000),
          });
          expect(response.ok, `preview ${action}: ${await response.text()}`).toBe(true);
        }
        simctl("install", udid, FIXTURE);
        fixtureLog = join(
          simctl("get_app_container", udid, APP, "data").trim(),
          "Documents/launches.tsv",
        );
        await launchFixture();
        await tapFixture("same-server reboot recovery");
        expect(serverExited()).toBe(false);
      }
    } catch (error) {
      try {
        console.error(
          readFileSync(serverLog, "utf8")
            .split("\n")
            .filter((line) => !line.includes("token="))
            .slice(-60)
            .join("\n"),
        );
      } catch {}
      console.error(lines().slice(-15).join("\n"));
      throw error;
    } finally {
      server?.kill("SIGTERM");
      try {
        if (server) await waitFor(serverExited, "server never stopped");
      } catch {
        server?.kill("SIGKILL");
      }
      try {
        await restartBackBoard(0);
      } finally {
        try {
          simctl("uninstall", udid, APP);
        } catch {}
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  },
  360_000,
);
