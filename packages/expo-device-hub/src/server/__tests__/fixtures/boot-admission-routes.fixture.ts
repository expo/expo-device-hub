/// <reference types="bun" />

/**
 * Runs in its own `bun test` process, because it replaces the vendored
 * serve-sim and serve-emu modules and the default admission: the Hub's real
 * request handler must gate the two start routes before forwarding.
 */

import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootAdmissionHost } from "../../boot-admission";
import { fakeProcessTable } from "./boot-admission-fake-host";

const X = "11111111-1111-1111-1111-111111111111";
const Y = "22222222-2222-2222-2222-222222222222";
const reached: { path: string; body: string }[] = [];

async function record(request: Request): Promise<void> {
  reached.push({ path: new URL(request.url).pathname, body: await request.text() });
}

mock.module("../../../../vendor/serve-sim/dist/middleware.js", () => ({
  simMiddleware: () =>
    Object.assign(
      async (request: Request) => {
        await record(request);
        return Response.json({ ok: true });
      },
      { dispose: async () => {} },
    ),
}));
mock.module("../../../../vendor/serve-emu/dist/middleware.js", () => ({
  cameraLaunchArgs: () => [],
  seedCameraFeeds: async () => {},
  fromWsSocket: (socket: unknown) => socket,
  SESSION_TOKEN_SUBPROTOCOL_PREFIX: "serve-emu.token.",
  createRouter: () => ({
    handleRequest: async (request: Request) => {
      await record(request);
      return Response.json({ ok: true, serial: "emulator-5560" });
    },
    stopAll: async () => {},
  }),
}));

mock.module("../../device-list-websocket", () => ({
  deviceListWebSocketHandler() {},
  refreshDeviceList() {},
}));

const dir = mkdtempSync(join(tmpdir(), "boot-admission-routes-fixture-"));
mkdirSync(join(dir, "device-hub"));
const policyFile = join(dir, "device-hub", "host-policy.json");
const fakeHost: BootAdmissionHost = {
  async readOccupancy() {
    return {
      value: {
        simulators: [{ udid: X, name: "iPhone", state: "Booted" }],
        androidDevices: [{ serial: "emulator-5554", state: "device", avdName: "Pixel_9" }],
      },
      error: null,
    };
  },
  async readProcesses() {
    return { value: fakeProcessTable([[process.pid, "bun test"]]), error: null };
  },
  pidExists: (pid) => pid === process.pid,
};
const realAdmission = await import("../../boot-admission");
mock.module("../../boot-admission", () => ({
  ...realAdmission,
  defaultBootAdmission: realAdmission.createBootAdmission({
    policyFile,
    stateDir: join(dir, "device-hub", "boot-admission"),
    host: fakeHost,
  }),
}));

process.env.EXPO_DEVICE_HUB_BASE_PATH = "";
const { MOUNT_PATH } = await import("../../mount");
const server = await import("../../index");
const hub = async (request: Request): Promise<Response> => (await server.default(request))!;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });
}

test("without a policy both start routes reach their servers", async () => {
  reached.length = 0;
  await hub(post("/vendor/serve-sim/grid/api/start", { udid: Y }));
  await hub(post("/vendor/serve-emu/api/avds/start", { avd: "Pixel_8" }));

  expect(reached).toEqual([
    { path: `${MOUNT_PATH}/vendor/serve-sim/grid/api/start`, body: JSON.stringify({ udid: Y }) },
    { path: "/api/avds/start", body: JSON.stringify({ avd: "Pixel_8" }) },
  ]);
});

test("at capacity a different simulator's start never reaches serve-sim", async () => {
  writeFileSync(policyFile, JSON.stringify({ maxVirtualDevices: 2 }));
  reached.length = 0;

  const refused = await hub(post("/vendor/serve-sim/grid/api/start", { udid: Y }));

  expect(refused.status).toBe(500);
  expect((await refused.json()).error).toStartWith("Device host capacity reached: 2 of 2");
  expect(reached).toEqual([]);
});

test("at capacity a different AVD's start never reaches serve-emu", async () => {
  reached.length = 0;

  const refused = await hub(post("/vendor/serve-emu/api/avds/start", { avd: "Pixel_8" }));

  expect(refused.status).toBe(400);
  expect(reached).toEqual([]);
});

test("at capacity a start of a counted device reaches its server", async () => {
  reached.length = 0;

  await hub(post("/vendor/serve-sim/grid/api/start", { udid: X }));
  await hub(post("/vendor/serve-emu/api/avds/start", { avd: "Pixel_9" }));

  expect(reached.map((entry) => entry.path)).toEqual([
    `${MOUNT_PATH}/vendor/serve-sim/grid/api/start`,
    "/api/avds/start",
  ]);
});
