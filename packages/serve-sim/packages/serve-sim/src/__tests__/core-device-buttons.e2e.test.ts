import { expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Dedicated-device opt-in: opens CoreDevice HID, changes foreground UI and locks
// the screen. Never select a shared booted simulator implicitly.
const enabled = process.env.SERVE_SIM_HID_BUTTONS_E2E === "1";
const app = "dev.expo.serve-sim.launch-fixture";
const addon = join(import.meta.dir, "../../dist/native/serve-sim-native.node");
function simctl(...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 30_000 });
}

test.skipIf(!enabled)(
  "CoreDevice buttons reach UIKit and missing button encoding rejects without disabling touch",
  async () => {
    const udid = process.env.SERVE_SIM_TEST_UDID;
    if (!udid) throw new Error("set SERVE_SIM_TEST_UDID to a dedicated iOS 27 iPhone");
    const devices = JSON.parse(simctl("list", "devices", "booted", "-j")) as {
      devices: Record<string, { udid: string; deviceTypeIdentifier: string }[]>;
    };
    expect(
      Object.entries(devices.devices).some(
        ([runtime, list]) =>
          runtime.includes("iOS-27") &&
          list.some((d) => d.udid === udid && d.deviceTypeIdentifier.includes("iPhone")),
      ),
    ).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "serve-sim-buttons-"));
    simctl(
      "install",
      udid,
      join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app"),
    );
    const log = join(
      simctl("get_app_container", udid, app, "data").trim(),
      "Documents/launches.tsv",
    );
    const lines = () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    const waitFor = async (start: number, kind: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (
          lines()
            .slice(start)
            .some((line) => line.startsWith(`${kind}\t`))
        )
          return;
        await Bun.sleep(100);
      }
      throw new Error(`Guest never recorded ${kind}`);
    };
    const launch = async () => {
      const start = lines().length;
      simctl("launch", "--terminate-running-process", udid, app, "--input-test");
      await waitFor(start, "input-ready");
      // The accepted post-relaunch touch-loss window is a separate follow-up.
      await Bun.sleep(500);
    };
    // Invoke the actual executable: a shell-based toolchain shim can strip DYLD_*.
    const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
    const input = (code: string, library?: string) =>
      execFileSync(
        node,
        [
          "--input-type=module",
          "-e",
          `
    import {createRequire} from 'node:module';
    import assert from 'node:assert/strict';
    const {SimHID} = createRequire(import.meta.url)(process.argv[1]);
    const hid = new SimHID(process.argv[2]);
    await hid.setScreen(1);
    ${code}
    await new Promise(resolve => setTimeout(resolve, 200));
    process.exit(0);
  `,
          addon,
          udid,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            ...(library
              ? {
                  DYLD_INSERT_LIBRARIES: [library, process.env.DYLD_INSERT_LIBRARIES]
                    .filter(Boolean)
                    .join(":"),
                }
              : {}),
          },
        },
      );
    try {
      await launch();
      const library = join(directory, "no-button.dylib");
      execFileSync(
        "xcrun",
        [
          "clang",
          "-dynamiclib",
          "-arch",
          "arm64",
          "-o",
          library,
          join(import.meta.dir, "fixtures/hid-no-button.c"),
        ],
        { timeout: 30_000 },
      );
      const start = lines().length;
      expect(
        input(
          `
      await assert.rejects(hid.button('lock'), /CoreDevice button input/);
      await assert.rejects(hid.buttonHid(12, 233, 'press'), /CoreDevice button input/);
      await hid.touch('begin', .5, .5, 1206, 2622, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
      await hid.touch('end', .5, .5, 1206, 2622, 0);
    `,
          library,
        ),
      ).toContain("[test] CoreDevice button symbol hidden");
      await waitFor(start, "touch-ended");
      for (const command of ["await hid.button('app_switcher')", "await hid.button('lock')"]) {
        await launch();
        const before = lines().length;
        input(command);
        await waitFor(before, "input-inactive");
      }
    } finally {
      simctl("uninstall", udid, app);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
