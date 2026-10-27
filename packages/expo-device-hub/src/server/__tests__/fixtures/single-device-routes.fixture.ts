import { expect, mock, test } from "bun:test";

const platform = process.env.HUB_TEST_PLATFORM as "ios" | "android";
const id = platform === "ios" ? "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" : "emulator-5554";
const token = "single-device-route-test";
const backendRequests: Request[] = [];
const actions: string[] = [];
let simOptions: Record<string, unknown> = {};

mock.module("../../../../vendor/serve-sim/dist/middleware.js", () => ({
  simMiddleware: (options: Record<string, unknown>) => {
    simOptions = options;
    return Object.assign(
      async (request: Request) => {
        backendRequests.push(request);
        return new Response("sim");
      },
      { dispose: async () => {} },
    );
  },
}));
mock.module("../../../../vendor/serve-emu/dist/middleware.js", () => ({
  cameraLaunchArgs: () => [],
  seedCameraFeeds: async () => {},
  fromWsSocket: (socket: unknown) => socket,
  SESSION_TOKEN_SUBPROTOCOL_PREFIX: "serve-emu.token.",
  createRouter: () => ({
    handleRequest: async (request: Request) => {
      backendRequests.push(request);
      return new Response("emu");
    },
    stopAll: async () => {},
  }),
}));
const realActions = await import("../../device-actions");
mock.module("../../device-actions", () => ({
  ...realActions,
  bootHubDevice: async () => {
    actions.push("boot");
    return { ok: true, id };
  },
  shutdownHubDevice: async () => {
    actions.push("shutdown");
    return { ok: true };
  },
  removeHubDevice: async () => {
    actions.push("remove");
    return { ok: true };
  },
  createHubDevice: async () => {
    actions.push("create");
    return { ok: true };
  },
}));
mock.module("../../device-list-websocket", () => ({
  deviceListWebSocketHandler() {},
  refreshDeviceList() {},
}));
process.env.EXPO_DEVICE_HUB_BASE_PATH = "";
process.env.EXPO_DEVICE_HUB_PLATFORM = platform;
process.env.EXPO_DEVICE_HUB_SINGLE_DEVICE = id;
process.env.EXPO_DEVICE_HUB_SESSION_TOKEN = token;
const server = await import("../../index");
const request = (path: string, init: RequestInit = {}) =>
  server.default(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    }),
  );

for (const action of ["boot", "shutdown", "remove"] as const) {
  test(`${action} rejects a different device before invoking native actions`, async () => {
    actions.length = 0;
    const response = await request(`/api/devices/${action}`, {
      method: "POST",
      body: JSON.stringify({ platform, id: "other", name: "other" }),
    });
    expect(response?.status).toBe(403);
    expect(actions).toEqual([]);
  });
}
test("shutdown permits only the pinned platform and device", async () => {
  actions.length = 0;
  expect(
    (
      await request("/api/devices/shutdown", {
        method: "POST",
        body: JSON.stringify({ platform, id }),
      })
    )?.status,
  ).toBe(200);
  expect(actions).toEqual(["shutdown"]);
  expect(
    (
      await request("/api/devices/shutdown", {
        method: "POST",
        body: JSON.stringify({ platform: platform === "ios" ? "android" : "ios", id }),
      })
    )?.status,
  ).toBe(403);
  expect(actions).toEqual(["shutdown"]);
});
test("creation and deletion stay unavailable", async () => {
  actions.length = 0;
  for (const action of ["create", "remove"]) {
    expect(
      (
        await request(`/api/devices/${action}`, {
          method: "POST",
          body: JSON.stringify({ platform, id, name: "other" }),
        })
      )?.status,
    ).toBe(403);
  }
  expect(actions).toEqual([]);
});
test("the other platform never reaches its device server", async () => {
  backendRequests.length = 0;
  expect((await request(`/vendor/serve-${platform === "ios" ? "emu" : "sim"}/api`))?.status).toBe(
    403,
  );
  expect(backendRequests).toEqual([]);
});
test("authentication remains required", async () => {
  expect(
    (
      await server.default(
        new Request("http://localhost/api/devices/shutdown", {
          method: "POST",
          body: JSON.stringify({ platform, id }),
        }),
      )
    )?.status,
  ).toBe(401);
});
if (platform === "android") {
  test("Android backend receives a pinned default and refuses overrides and fleet actions", async () => {
    backendRequests.length = 0;
    expect((await request("/vendor/serve-emu/api/screenshot"))?.status).toBe(200);
    expect(new URL(backendRequests[0]!.url).searchParams.get("device")).toBe(id);
    for (const path of ["/api/screenshot?device=other", "/api/devices", "/api/avds/start"]) {
      expect((await request(`/vendor/serve-emu${path}`))?.status).toBe(403);
    }
    expect(backendRequests).toHaveLength(1);
  });
} else {
  test("the actual serve-sim mount receives the immutable policy", () => {
    expect(simOptions.singleDevice).toBe(id);
  });
  test("the pinned Simulator can be restarted", async () => {
    actions.length = 0;
    expect(
      (
        await request("/api/devices/boot", {
          method: "POST",
          body: JSON.stringify({ platform, id }),
        })
      )?.status,
    ).toBe(200);
    expect(actions).toEqual(["boot"]);
  });
}
