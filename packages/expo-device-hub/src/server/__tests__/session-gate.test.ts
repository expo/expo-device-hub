import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import { accessCookieName } from "../session-auth";

// The real device servers answer each preflight. Loaded through a variable, so the Hub's type check
// does not compile their sources, which use another `tsconfig`.
const EMU_SOURCE = "../../../../serve-emu/packages/serve-emu/src/middleware.ts";
const SIM_SOURCE = "../../../../serve-sim/packages/serve-sim/src/middleware.ts";
const EMU_SRC = "../../../../serve-emu/packages/serve-emu/src";
const { createRouter: realEmuRouter } = (await import(EMU_SOURCE)) as {
  createRouter: (options: { allowedOrigins?: string[] }) => {
    handleRequest(request: Request): Promise<Response>;
  };
};
const { simMiddleware: realSimMiddleware } = (await import(SIM_SOURCE)) as {
  simMiddleware: (options: {
    basePath: string;
    corsOrigins?: string[];
  }) => (request: Request) => Promise<Response | undefined>;
};

type EmuAttachOptions = { request?: Request; video: boolean; frameMeta: boolean };
const { fromWsSocket: realFromWsSocket } = (await import(`${EMU_SRC}/stream-socket.ts`)) as {
  fromWsSocket: (socket: unknown) => unknown;
};

const TOKEN = "hub-gate-token";
const ORIGIN = "http://192.168.1.20:3400";
const cookie = `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`;
const SAME_ORIGIN = { cookie, "sec-fetch-site": "same-origin" };
// The policy for the `--frame-ancestor` origin the CLI hands over below.
const FRAME_POLICY = "frame-ancestors 'self' https://*.expo.dev";
// The `--cors-origin` page the CLI hands over below.
const PAGE = "https://page.example";

// What reached each vendored backend, and with which credential.
const simRequests: Request[] = [];
const simSockets: Request[] = [];
const emuRequests: Request[] = [];
const emuUpgrades: Request[] = [];
const emuAttached: Array<{ request?: Request }> = [];
// A test that needs serve-emu's real socket handling sets this.
let emuAttach: ((socket: unknown, options: EmuAttachOptions) => void) | null = null;
let simOptions: Record<string, unknown> = {};
let emuOptions: Record<string, unknown> = {};
let deviceListings = 0;

mock.module("../../../vendor/serve-sim/dist/middleware.js", () => ({
  simMiddleware: (options: Record<string, unknown>) => {
    simOptions = options;
    // The real middleware answers each preflight, so a test sees what a browser gets before it sends
    // the request itself.
    const preflight = realSimMiddleware({
      basePath: options.basePath as string,
      corsOrigins: options.corsOrigins as string[],
    });
    return Object.assign(
      async (request: Request) => {
        simRequests.push(request);
        if (request.method === "OPTIONS") return preflight(request);
        // serve-sim names its own frame policy on its pages.
        if (new URL(request.url).pathname.endsWith("/framed")) {
          return new Response("sim", {
            headers: { "Content-Security-Policy": "frame-ancestors 'self' https://a.dev" },
          });
        }
        return new Response("sim");
      },
      {
        handleWebSocket: (request: Request) => {
          simSockets.push(request);
          return true;
        },
      },
    );
  },
}));

mock.module("../../../vendor/serve-emu/dist/middleware.js", () => ({
  cameraLaunchArgs: () => [],
  seedCameraFeeds: async () => {},
  fromWsSocket: realFromWsSocket,
  SESSION_TOKEN_SUBPROTOCOL_PREFIX: "serve-emu.token.",
  createRouter: (options: Record<string, unknown>) => {
    emuOptions = options;
    // The real router answers each preflight, before its token gate and without a device.
    const preflight = realEmuRouter({ allowedOrigins: options.allowedOrigins as string[] });
    return {
      handleRequest: async (request: Request) => {
        emuRequests.push(request);
        if (request.method === "OPTIONS") return preflight.handleRequest(request);
        // A redirect's headers are immutable.
        if (new URL(request.url).pathname === "/moved")
          return Response.redirect("http://emu.test/", 302);
        return new Response("emu");
      },
      authorizeUpgrade: (request: Request) => {
        emuUpgrades.push(request);
        return true;
      },
      ensure: async () => ({ serial: "emulator-5554" }),
      attachWebSocket: (socket: unknown, options: EmuAttachOptions) => {
        emuAttached.push(options);
        emuAttach?.(socket, options);
      },
      startScreenRecording: async () => {},
      finishScreenRecording: async () => null,
      stopAll: async () => {},
    };
  },
}));

mock.module("../devices", () => ({
  listDevices: async () => {
    deviceListings++;
    return { simulators: [], emulators: [], errors: [] };
  },
  listAndroidEmulators: async () => [],
}));

// The standalone CLI sets these before it imports the server bundle.
const previousEnv = { ...process.env };
process.env.EXPO_DEVICE_HUB_BASE_PATH = "";
process.env.EXPO_DEVICE_HUB_SESSION_TOKEN = TOKEN;
process.env.EXPO_DEVICE_HUB_FRAME_ANCESTORS = JSON.stringify(["https://*.expo.dev"]);
process.env.EXPO_DEVICE_HUB_RECORDING_CONTROL_TOKEN = "recording-token";
process.env.EXPO_DEVICE_HUB_SERVE_SIM_OPTIONS = JSON.stringify({ corsOrigins: [PAGE] });
process.env.EXPO_DEVICE_HUB_SERVE_EMU_OPTIONS = JSON.stringify({ allowedOrigins: [PAGE] });
const server = await import("../index");

afterAll(() => {
  process.env = previousEnv;
});

beforeEach(() => {
  simRequests.length = 0;
  simSockets.length = 0;
  emuRequests.length = 0;
  emuUpgrades.length = 0;
  emuAttached.length = 0;
  deviceListings = 0;
});

const request = (path: string, init?: RequestInit) =>
  server.default(new Request(`${ORIGIN}${path}`, init));

function fakeSocket() {
  const socket = {
    closed: null as null | { code?: number; reason?: string },
    bufferedAmount: 0,
    send: () => {},
    on: () => {},
    close(code?: number, reason?: string) {
      socket.closed = { code, reason };
    },
  };
  return socket;
}

function openSocket(route: string, headers: Record<string, string> = {}) {
  const socket = fakeSocket();
  const handler = server.webSocketHandlers[route as keyof typeof server.webSocketHandlers] as (
    socket: unknown,
    request: Request,
  ) => void;
  handler(socket, new Request(`${ORIGIN}${route}`, { headers }));
  return socket;
}

describe("the Hub under a session token", () => {
  test("hands the token to the vendored serve-sim and serve-emu gates", () => {
    expect(simOptions).toMatchObject({
      execToken: TOKEN,
      requirePreviewToken: true,
      frameAncestors: ["https://*.expo.dev"],
    });
    expect(emuOptions).toMatchObject({ sessionToken: TOKEN });
  });

  test("lets only the Hub and each --frame-ancestor frame its pages", async () => {
    const response = await request("/", { headers: { "sec-fetch-dest": "document" } });

    expect(response?.status).toBe(401);
    expect(response?.headers.get("content-security-policy")).toBe(FRAME_POLICY);
  });

  test("refuses its own routes and both backends without the token", async () => {
    const paths = [
      "/",
      "/index.html",
      "/api/devices",
      "/api/new-device-options",
      "/metrics",
      "/vendor/serve-sim/api",
      "/vendor/serve-emu/api/devices",
    ];

    for (const path of paths) expect([path, (await request(path))?.status]).toEqual([path, 401]);
    expect((await request("/api/devices/boot", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect(deviceListings).toBe(0);
    expect(simRequests).toEqual([]);
    expect(emuRequests).toEqual([]);
  });

  // Otherwise the page sees only a network error, as if the Hub were down.
  test("lets a --cors-origin page read why either backend refused it", async () => {
    for (const path of ["/vendor/serve-sim/api", "/vendor/serve-emu/api/devices"]) {
      const response = await request(path, { headers: { Origin: PAGE } });
      expect([path, response?.status]).toEqual([path, 401]);
      expect(response?.headers.get("access-control-allow-origin")).toBe(PAGE);
      expect(response?.headers.get("vary")).toBe("Origin");
    }
  });

  // A browser sends the preflight first, then the request with the token it has.
  test("lets a --cors-origin page read every kind of token refusal after its preflight", async () => {
    // Each backend's real preflight lets the page send the token header at all.
    for (const path of ["/vendor/serve-emu/api/devices", "/vendor/serve-sim/api"]) {
      const preflight = await request(path, {
        method: "OPTIONS",
        headers: {
          Origin: PAGE,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      });
      expect([path, preflight?.status]).toEqual([path, 204]);
      expect([path, preflight?.headers.get("access-control-allow-origin")]).toEqual([path, PAGE]);
      expect(preflight?.headers.get("access-control-allow-headers")).toContain("Authorization");
    }
    simRequests.length = 0;
    emuRequests.length = 0;

    const wrong = { Origin: PAGE, Authorization: "Bearer wrong-token" };
    const refusals: Array<[string, RequestInit]> = [
      ["/vendor/serve-emu/api/devices", { headers: wrong }],
      ["/vendor/serve-sim/api", { headers: wrong }],
      ["/vendor/serve-emu/api/devices?token=wrong-token", { headers: { Origin: PAGE } }],
      ["/vendor/serve-sim/stream.mjpeg?token=wrong-token", { headers: { Origin: PAGE } }],
      ["/vendor/serve-emu/api/screenshot", { method: "POST", headers: wrong }],
      ["/vendor/serve-emu/api/devices", { headers: { ...wrong, "sec-fetch-dest": "document" } }],
    ];
    for (const [path, init] of refusals) {
      const response = await request(path, init);
      const body = (await response?.text()) ?? "";
      expect([path, response?.status]).toEqual([path, 401]);
      expect([path, response?.headers.get("access-control-allow-origin")]).toEqual([path, PAGE]);
      expect([path, body.includes("wrong-token") || body.includes(TOKEN)]).toEqual([path, false]);
    }
    expect(simRequests).toEqual([]);
    expect(emuRequests).toEqual([]);
  });

  test("names no other origin on a refusal, and none on its own routes", async () => {
    const other = await request("/vendor/serve-emu/api/devices", {
      headers: { Origin: "https://elsewhere.example" },
    });
    const own = await request("/api/devices", { headers: { Origin: PAGE } });

    expect(other?.status).toBe(401);
    expect(other?.headers.get("access-control-allow-origin")).toBeNull();
    expect(other?.headers.get("vary")).toBe("Origin");
    expect(own?.status).toBe(401);
    expect(own?.headers.get("access-control-allow-origin")).toBeNull();
  });

  // serve-sim allows any loopback page; serve-emu only one that calls a Hub on a loopback host.
  test("follows each backend's loopback rule on a refusal", async () => {
    const headers = { Origin: "http://localhost:5173" };
    const allowOrigin = async (url: string) =>
      (await server.default(new Request(url, { headers })))?.headers.get(
        "access-control-allow-origin",
      );

    expect(await allowOrigin(`${ORIGIN}/vendor/serve-sim/api`)).toBe("http://localhost:5173");
    expect(await allowOrigin(`${ORIGIN}/vendor/serve-emu/api/devices`)).toBeNull();
    expect(await allowOrigin("http://127.0.0.1:3400/vendor/serve-emu/api/devices")).toBe(
      "http://localhost:5173",
    );
  });

  // serve-emu counts `*.localhost` as loopback; serve-sim does not.
  test("names a *.localhost page on a serve-emu refusal only", async () => {
    const allowOrigin = async (url: string) =>
      (
        await server.default(
          new Request(url, { headers: { Origin: "http://preview.localhost:5173" } }),
        )
      )?.headers.get("access-control-allow-origin");

    expect(await allowOrigin("http://127.0.0.1:3400/vendor/serve-emu/api/devices")).toBe(
      "http://preview.localhost:5173",
    );
    expect(await allowOrigin("http://127.0.0.1:3400/vendor/serve-sim/api")).toBeNull();
  });

  // A route the Hub does not know still falls through to static files, so it is gated too.
  test("refuses a path it does not route, which the CLI would serve as a static file", async () => {
    expect((await request("/_expo/static/js/web/index.js"))?.status).toBe(401);
  });

  // The expo.dev preview page probes `/healthz` without a token, as it does serve-sim's.
  test("keeps the health and readiness probes open", async () => {
    expect((await request("/healthz"))?.status).toBe(200);
    expect((await request("/readyz"))?.status).toBe(200);
  });

  // EAS stops the recording with its own token, which is not the session token.
  test("leaves the recording stop to its own token", async () => {
    const response = await request("/_eas/android-recording/stop", {
      method: "POST",
      headers: { Authorization: "Bearer recording-token" },
    });

    expect(response?.status).not.toBe(401);
  });

  test("answers its own routes for the cookie it handed out", async () => {
    expect((await request("/api/devices", { headers: SAME_ORIGIN }))?.status).toBe(200);
    expect(deviceListings).toBe(1);
  });

  // The backends never see the Hub's cookie name, so the Hub passes the token on as a bearer.
  test("forwards an authorized request to each backend with the token as a bearer", async () => {
    await request("/vendor/serve-sim/api", { headers: SAME_ORIGIN });
    await request("/vendor/serve-emu/api/devices", { headers: SAME_ORIGIN });

    expect(simRequests.map((r) => r.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`]);
    expect(emuRequests.map((r) => r.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`]);
  });

  // serve-emu's own UI is a page that takes input, so no gated response may be framed by any site.
  test("sends the frame policy on every response it routes, not only on the dashboard", async () => {
    for (const path of [
      "/vendor/serve-emu/",
      "/vendor/serve-emu/moved",
      "/vendor/serve-sim/api",
      "/readyz",
    ]) {
      const response = await request(path, { headers: SAME_ORIGIN });
      expect([path, response?.headers.get("content-security-policy")]).toEqual([
        path,
        FRAME_POLICY,
      ]);
    }
    // The CLI sets these on the static files it serves after `handler` passed a request on.
    expect(server.staticFileHeaders).toEqual({ "Content-Security-Policy": FRAME_POLICY });
  });

  test("keeps a backend's own frame policy", async () => {
    const response = await request("/vendor/serve-sim/framed", { headers: SAME_ORIGIN });

    expect(response?.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://a.dev",
    );
  });

  // A preflight cannot carry the token. Each backend answers or refuses one before its own gate.
  test("passes a backend preflight through without a credential, and refuses one for the Hub", async () => {
    expect((await request("/vendor/serve-sim/api", { method: "OPTIONS" }))?.status).toBe(204);
    expect((await request("/vendor/serve-emu/webrtc/stats", { method: "OPTIONS" }))?.status).toBe(
      204,
    );

    expect(simRequests.map((r) => r.headers.get("authorization"))).toEqual([null]);
    expect(emuRequests.map((r) => r.headers.get("authorization"))).toEqual([null]);
    expect((await request("/api/devices", { method: "OPTIONS" }))?.status).toBe(401);
  });

  // serve-sim takes recording control only with a bearer, never with its cookie.
  test("forwards recording control with the credential it came with, never one it adds", async () => {
    const path = "/vendor/serve-sim/helper/UDID-1/recording/video";

    await request(path, { method: "POST", headers: SAME_ORIGIN, body: "{}" });
    await request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });

    expect(simRequests.map((r) => r.headers.get("authorization"))).toEqual([
      null,
      `Bearer ${TOKEN}`,
    ]);
  });

  // serve-sim drops empty path segments, so these paths reach recording control too.
  test("adds no bearer to recording control spelled with extra slashes", async () => {
    for (const path of [
      "/vendor/serve-sim/helper/UDID-1//recording/video",
      "/vendor/serve-sim/helper//UDID-1/recording//video/",
    ]) {
      await request(path, { method: "POST", headers: SAME_ORIGIN, body: "{}" });
    }

    expect(simRequests.map((r) => r.headers.get("authorization"))).toEqual([null, null]);
  });

  // serve-sim never takes the token from a capture URL, which logs and referrers can record.
  test("refuses a query token on the capture routes", async () => {
    expect(
      (await request(`/vendor/serve-sim/network-capture?device=UDID-1&token=${TOKEN}`))?.status,
    ).toBe(401);
    expect(
      (await request("/vendor/serve-sim/network-capture?device=UDID-1", { headers: SAME_ORIGIN }))
        ?.status,
    ).toBe(200);
  });

  test("closes every socket that carries no token, before it reaches a backend", () => {
    for (const route of Object.keys(server.webSocketHandlers)) {
      expect([route, openSocket(route).closed]).toEqual([
        route,
        { code: 1008, reason: "Unauthorized" },
      ]);
    }
    expect(simSockets).toEqual([]);
    expect(emuUpgrades).toEqual([]);
  });

  // `ws` emits `error` when a peer breaks the protocol, even while the socket closes, and an error
  // with no listener throws. Without one, any client could stop the Hub, token or not.
  test("handles a socket error on a refused socket and on an accepted serve-emu socket", () => {
    const refused = Object.assign(new EventEmitter(), { close() {} });
    const accepted = Object.assign(new EventEmitter(), {
      close() {},
      bufferedAmount: 0,
      send() {},
    });
    const handlers = server.webSocketHandlers as Record<
      string,
      (socket: unknown, request: Request) => void
    >;

    handlers["/api/devices/ws"](refused, new Request(`${ORIGIN}/api/devices/ws`));
    handlers["/vendor/serve-emu/ws"](
      accepted,
      new Request(`${ORIGIN}/vendor/serve-emu/ws`, {
        headers: { "sec-websocket-protocol": `serve-emu.token.${TOKEN}` },
      }),
    );

    expect(() => refused.emit("error", new Error("WS_ERR_EXPECTED_MASK"))).not.toThrow();
    expect(() => accepted.emit("error", new Error("WS_ERR_EXPECTED_MASK"))).not.toThrow();
  });

  test("forwards an authorized socket to each backend with the token as a bearer", async () => {
    const same = { cookie, origin: ORIGIN, host: "192.168.1.20:3400" };

    expect(openSocket("/vendor/serve-sim/exec-ws", same).closed).toBeNull();
    expect(
      openSocket("/vendor/serve-emu/ws", { "sec-websocket-protocol": `serve-emu.token.${TOKEN}` })
        .closed,
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(simSockets.map((r) => r.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`]);
    expect(emuUpgrades.map((r) => r.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`]);
    // serve-emu's `attachWebSocket` checks the token again and closes a socket that has none.
    expect(emuAttached.map((o) => o.request?.headers.get("authorization"))).toEqual([
      `Bearer ${TOKEN}`,
    ]);
  });
});

/** A scrcpy session with no frames; serve-emu decides the transport lock before reading a frame. */
function idleScrcpySession() {
  let end!: (frame: null) => void;
  const ended = new Promise<null>((resolve) => {
    end = resolve;
  });
  return {
    transport: "scrcpy",
    meta: { deviceName: "hub-lock-test", codecId: "h264", width: 720, height: 1280 },
    protocol: 3,
    videoReader: {},
    controlSocket: Object.assign(new EventEmitter(), { write: () => true }),
    proc: new EventEmitter(),
    scid: "00000001",
    localPort: 27_200,
    serial: "emulator-5554",
    readFrame: () => ended,
    close: () => end(null),
  };
}

describe("serve-emu --transport webrtc through the Hub", () => {
  // The Hub's real socket route, `ws` wiring as in the CLI, and serve-emu's real `ws` adapter and
  // app. Only the device session is fake.
  test("a video WebSocket closes with 1008 in the browser, and the input-only one stays open", async () => {
    const { createApp } = (await import(`${EMU_SRC}/middleware.ts`)) as {
      createApp: (
        options: object,
        deps: object,
      ) => Promise<{
        attachWebSocket(socket: unknown, options: EmuAttachOptions): void;
        stop(): Promise<void>;
      }>;
    };
    const { adaptScrcpySession } = (await import(`${EMU_SRC}/stream-session.ts`)) as {
      adaptScrcpySession: (session: unknown) => unknown;
    };
    const app = await createApp(
      {
        serial: "emulator-5554",
        streamSettings: {
          transport: "webrtc",
          codec: "h264",
          iceServers: [],
          iceTransportPolicy: "all",
        },
      },
      {
        startSession: async () => adaptScrcpySession(idleScrcpySession()),
        createWebRtcPublisher: async () => ({
          activePeerCount: 0,
          close() {},
          resetVideoSource() {},
        }),
      },
    );
    emuAttach = (socket, options) => app.attachWebSocket(socket, options);

    const route = "/vendor/serve-emu/ws";
    const handler = server.webSocketHandlers[route] as (socket: unknown, request: Request) => void;
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (socket, incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      handler(socket, new Request(`${ORIGIN}${incoming.url}`, { headers }));
    });
    const http = createServer();
    http.on("upgrade", (incoming, socket, head) =>
      wss.handleUpgrade(incoming, socket, head, (ws) => wss.emit("connection", ws, incoming)),
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;

    // How a browser socket ended, or "open" when it is still open after 300 ms.
    const outcome = (query: string) =>
      new Promise<{ code: number; reason: string } | "open">((resolve) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}${route}?device=emulator-5554${query}`,
          [`serve-emu.token.${TOKEN}`],
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        socket.addEventListener("open", () => {
          timer = setTimeout(() => {
            resolve("open");
            socket.close();
          }, 300);
        });
        socket.addEventListener("close", (event) => {
          clearTimeout(timer);
          resolve({ code: event.code, reason: event.reason });
        });
      });

    try {
      expect(await outcome("")).toEqual({ code: 1008, reason: "stream_transport_locked" });
      expect(await outcome("&video=0")).toBe("open");
    } finally {
      emuAttach = null;
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      await app.stop();
    }
  });
});
