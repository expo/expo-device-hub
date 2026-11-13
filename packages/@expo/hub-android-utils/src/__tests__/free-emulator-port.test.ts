import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMULATOR_PORT_MAX, EMULATOR_PORT_MIN, freeEmulatorPort } from "../free-emulator-port";
import { clearSdkRootsCache } from "../sdk-paths";

const lister =
  (...serials: string[]) =>
  async () => ({ value: serials, error: null });

describe("freeEmulatorPort", () => {
  test("returns the lowest port when no emulators are running", async () => {
    expect((await freeEmulatorPort(lister())).value).toBe(EMULATOR_PORT_MIN);
  });

  test("skips ports already held by running emulators", async () => {
    expect((await freeEmulatorPort(lister("emulator-5554"))).value).toBe(5556);
  });

  test("returns the lowest free port when higher ones are also taken", async () => {
    expect((await freeEmulatorPort(lister("emulator-5554", "emulator-5558"))).value).toBe(5556);
  });

  test("ignores physical devices when computing used ports", async () => {
    expect((await freeEmulatorPort(lister("27151JEGR11854"))).value).toBe(EMULATOR_PORT_MIN);
  });

  test("returns the highest port when it is the only one free", async () => {
    const serials: string[] = [];
    for (let port = EMULATOR_PORT_MIN; port < EMULATOR_PORT_MAX; port += 2) {
      serials.push(`emulator-${port}`);
    }
    expect((await freeEmulatorPort(lister(...serials))).value).toBe(EMULATOR_PORT_MAX);
  });

  test("throws when every port in the range is taken", async () => {
    const serials: string[] = [];
    for (let port = EMULATOR_PORT_MIN; port <= EMULATOR_PORT_MAX; port += 2) {
      serials.push(`emulator-${port}`);
    }
    await expect(freeEmulatorPort(lister(...serials))).rejects.toThrow(
      "No free emulator console port available",
    );
  });

  test("returns the first discovery error without allocating a port", async () => {
    const error = { message: "adb unavailable", error: new Error("missing") };
    const allocated = await freeEmulatorPort(async () => ({ value: [], error }));
    expect(allocated).toEqual({ value: null, error });
  });
});

// The fake SDK is a POSIX shell script; Windows resolves `adb.exe` instead.
describe.skipIf(process.platform === "win32")(
  "freeEmulatorPort with the default adb listing",
  () => {
    const savedHome = process.env.ANDROID_HOME;
    let sdk = "";

    beforeAll(() => {
      // A fake SDK whose adb lists one online emulator, one still booting
      // (`offline`) and one mid-handshake (`authorizing`).
      sdk = mkdtempSync(join(tmpdir(), "hub-free-port-"));
      mkdirSync(join(sdk, "platform-tools"));
      const adb = join(sdk, "platform-tools", "adb");
      writeFileSync(
        adb,
        [
          "#!/bin/sh",
          'if [ "$1" = devices ]; then',
          "  echo 'List of devices attached'",
          "  echo 'emulator-5554          offline transport_id:1'",
          "  echo 'emulator-5556          device product:sdk_gphone64 transport_id:2'",
          "  echo 'emulator-5558          authorizing transport_id:3'",
          "fi",
          "",
        ].join("\n"),
      );
      chmodSync(adb, 0o755);
      // An empty avdmanager, so no lookup falls through to a real SDK.
      const bin = join(sdk, "cmdline-tools", "latest", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "avdmanager"), "#!/bin/sh\n");
      chmodSync(join(bin, "avdmanager"), 0o755);
      process.env.ANDROID_HOME = sdk;
      clearSdkRootsCache();
    });

    afterAll(() => {
      if (savedHome === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = savedHome;
      clearSdkRootsCache();
      rmSync(sdk, { recursive: true, force: true });
    });

    test("counts the ports of emulators that are booting or offline as used", async () => {
      expect(await freeEmulatorPort()).toEqual({ value: 5560, error: null });
    });
  },
);
