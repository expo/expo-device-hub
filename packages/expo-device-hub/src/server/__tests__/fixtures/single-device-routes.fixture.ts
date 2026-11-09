import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, mock, test } from "bun:test";

const platform = process.env.HUB_TEST_PLATFORM as "ios" | "android";
const id = platform === "ios" ? "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" : "emulator-5554";
const token = "single-device-route-test";
const backendRequests: Request[] = [];
const actions: string[] = [];
let simOptions: Record<string, unknown> = {};

const png = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../serve-sim/packages/serve-sim/Sources/SimPasteboard/Icons/AppIcon60x60@2x.png",
  ),
);
const metadata = {
  width: 120,
  height: 120,
  displayRotation: "portrait",
  displayId: 1,
  displayCount: 1,
};
function backendResponse(request: Request, fallback: string) {
  if (!new URL(request.url).pathname.endsWith("/api/screenshot")) return new Response(fallback);
  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "X-Expo-Screenshot-Metadata": JSON.stringify(metadata),
      "Access-Control-Expose-Headers": "X-Expo-Screenshot-Metadata",
    },
  });
}

mock.module("../../../../vendor/serve-sim/dist/middleware.js", () => ({
  simMiddleware: (options: Record<string, unknown>) => {
    simOptions = options;
    return Object.assign(
      async (request: Request) => {
        backendRequests.push(request);
        return backendResponse(request, "sim");
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
      return backendResponse(request, "emu");
    },
    stopAll: async () => {},
  }),
}));
// Use this checkout's source in the isolated suite; no package build or native action is needed.
const androidUtils = await import("../../../../../@expo/hub-android-utils/src/index");
const appleUtils = await import("../../../../../@expo/hub-apple-utils/src/index");
mock.module("@expo/hub-android-utils", () => androidUtils);
mock.module("@expo/hub-apple-utils", () => appleUtils);
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

test("the authenticated Hub mount preserves screenshot PNG and metadata headers", async () => {
  const path = `/vendor/serve-${platform === "ios" ? "sim" : "emu"}/api/screenshot?device=${id}`;
  const response = await request(path, { method: "POST" });
  expect(response?.status).toBe(200);
  expect(response!.headers.get("Content-Type")).toBe("image/png");
  expect(JSON.parse(response!.headers.get("X-Expo-Screenshot-Metadata")!)).toEqual(metadata);
  expect(response!.headers.get("Access-Control-Expose-Headers")).toContain(
    "X-Expo-Screenshot-Metadata",
  );
  expect(Buffer.from(await response!.arrayBuffer())).toEqual(png);
  const before = backendRequests.length;
  const refused = await server.default(new Request(`http://localhost${path}`, { method: "POST" }));
  expect(refused?.status).toBe(401);
  expect(backendRequests).toHaveLength(before);
});
