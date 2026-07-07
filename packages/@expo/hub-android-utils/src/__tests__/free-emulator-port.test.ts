import { describe, expect, test } from "bun:test";
import { EMULATOR_PORT_MAX, EMULATOR_PORT_MIN, freeEmulatorPort } from "../free-emulator-port";
import type { AndroidDevice } from "../types";

const device = (serial: string | null, overrides: Partial<AndroidDevice> = {}): AndroidDevice => ({
  name: serial ?? "avd",
  type: "emulator",
  booted: serial !== null,
  serial,
  path: null,
  properties: {},
  config: {},
  ...overrides,
});

const lister =
  (...serials: (string | null)[]) =>
  async () =>
    serials.map((serial) => device(serial));

describe("freeEmulatorPort", () => {
  test("returns the lowest port when no emulators are running", async () => {
    expect(await freeEmulatorPort(lister())).toBe(EMULATOR_PORT_MIN);
  });

  test("skips ports already held by running emulators", async () => {
    expect(await freeEmulatorPort(lister("emulator-5554"))).toBe(5556);
  });

  test("returns the lowest free port when higher ones are also taken", async () => {
    expect(await freeEmulatorPort(lister("emulator-5554", "emulator-5558"))).toBe(5556);
  });

  test("ignores physical devices and unbooted AVDs when computing used ports", async () => {
    const list = lister("27151JEGR11854", null);
    expect(await freeEmulatorPort(list)).toBe(EMULATOR_PORT_MIN);
  });

  test("returns the highest port when it is the only one free", async () => {
    const serials: string[] = [];
    for (let port = EMULATOR_PORT_MIN; port < EMULATOR_PORT_MAX; port += 2) {
      serials.push(`emulator-${port}`);
    }
    expect(await freeEmulatorPort(lister(...serials))).toBe(EMULATOR_PORT_MAX);
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
});
