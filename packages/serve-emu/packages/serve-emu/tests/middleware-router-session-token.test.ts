import { describe, expect, test } from "bun:test";
import type { Device } from "../src/adb.ts";
import {
  createRouter,
  SESSION_TOKEN_SUBPROTOCOL_PREFIX,
  type EmuApp,
  type RouterDependencies,
  type StreamSocket,
} from "../src/middleware.ts";

const TOKEN = "router-session-token";
const SERIAL = "emulator-5554";
const ALLOWED_ORIGIN = "https://dashboard.example";

function trackedRouter(sessionToken?: string, allowedOrigins?: string[]) {
  const created: string[] = [];
  const launched: string[] = [];
  const attached: string[] = [];
  const devices: Device[] = [{ serial: SERIAL, state: "device" }];
  const dependencies: RouterDependencies = {
    listDevices: async () => devices,
    listAllDevices: async () => devices.map((device) => ({ ...device })),
    listAvds: async () => [],
    listRunningAvds: async () => [],
    resolveRunningAvds: async () => [],
    createApp: async ({ serial }) => {
      created.push(serial);
      return {
        session: { mode: "scrcpy", inputSource: "scrcpy", meta: { deviceName: serial } },
        getInputSource: () => "scrcpy",
        isStreaming: () => true,
        health: () => ({ status: "streaming" }),
        webRtcStats: () => null,
        handleRequest: async (request: Request) =>
          Response.json({ ok: true, path: new URL(request.url).pathname }),
        attachWebSocket: () => {
          attached.push(serial);
        },
        stop: async () => {},
      } as unknown as EmuApp;
    },
    startEmulator: async ({ avd }) => {
      launched.push(avd);
      return { serial: SERIAL, proc: null, ownsProcess: false, cameraFeed: false, stop: () => {} };
    },
  };
  const router = createRouter(
    { ...(sessionToken === undefined ? {} : { sessionToken }), ...(allowedOrigins ? { allowedOrigins } : {}) },
    dependencies,
  );
  const request = (path: string, init?: RequestInit) =>
    router.handleRequest(new Request(`http://router.test${path}`, init));
  return { router, request, created, launched, attached };
}

function upgrade(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`http://router.test/ws${query}`, { headers });
}

function closableSocket() {
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket = { close: (code?: number, reason?: string) => closes.push([code, reason]) } as unknown as StreamSocket;
  return { socket, closes };
}

function preflight(path: string, origin = ALLOWED_ORIGIN): RequestInit & { path: string } {
  return {
    path,
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
  };
}

describe("createRouter without a session token", () => {
  test("answers requests and upgrades as before", async () => {
    const { router, request, attached } = trackedRouter();

    expect((await request("/api/devices")).status).toBe(200);
    expect(router.authorizeUpgrade(upgrade())).toBe(true);
    await router.ensure(SERIAL);
    router.attachWebSocket(closableSocket().socket, { serial: SERIAL, frameMeta: false });
    expect(attached).toEqual([SERIAL]);
  });

  test("answers a WebRTC signaling preflight without starting a device", async () => {
    const { request, created } = trackedRouter(undefined, [ALLOWED_ORIGIN]);
    const { path, ...init } = preflight("/webrtc/offer");

    const response = await request(path, init);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(created).toEqual([]);
  });

  test("refuses an empty token rather than running open", () => {
    expect(() => trackedRouter("")).toThrow("sessionToken");
  });

  // A client sends the token as a header, a query, or a subprotocol, so the
  // router refuses one that cannot travel unchanged in all three.
  test("refuses a token that some clients could never send", () => {
    for (const token of ["a,b", " padded ", "with space", "a+b", "YWJjZA==", "semi;colon", "caf\u00e9", "end\n", "end\r", "end\r\n", "end\u2028"]) {
      expect(() => trackedRouter(token)).toThrow("sessionToken");
    }
  });

  test("takes base64url, hex, and UUID tokens", () => {
    for (const token of ["jJ3k_Qx-9Zp2", "9f86d081884c7d65", "550e8400-e29b-41d4-a716-446655440000", "a.b~c"]) {
      expect(() => trackedRouter(token)).not.toThrow();
    }
  });
});

describe("createRouter with a session token", () => {
  test("refuses every route without the token, before any device starts", async () => {
    const { request, created, launched } = trackedRouter(TOKEN);
    const json = { "Content-Type": "application/json" };
    const refused: Array<[string, RequestInit?]> = [
      ["/"],
      ["/index.html"],
      ["/health"],
      ["/api"],
      ["/api/devices"],
      ["/api/device-grid"],
      ["/api/logcat"],
      ["/api/stream-mode"],
      ["/api/camera"],
      ["/webrtc/stats?sessionId=00000000-0000-4000-8000-000000000000"],
      ["/webrtc/offer", { method: "POST", headers: json, body: "{}" }],
      ["/webrtc/close", { method: "POST", headers: json, body: "{}" }],
      ["/api/devices", { method: "HEAD" }],
      ["/api/devices/select", { method: "POST", headers: json, body: `{"serial":"${SERIAL}"}` }],
      ["/api/avds/start", { method: "POST", headers: json, body: '{"avd":"Pixel"}' }],
    ];

    const statuses = await Promise.all(
      refused.map(async ([path, init]) => [path, (await request(path, init)).status]),
    );

    expect(statuses.filter(([, status]) => status !== 401)).toEqual([]);
    expect(created).toEqual([]);
    expect(launched).toEqual([]);
  });

  test("answers with a structured 401 that names the scheme and never echoes a token", async () => {
    const { request } = trackedRouter(TOKEN);

    const response = await request("/api/devices?token=wrong-token", {
      headers: { Authorization: "Bearer another-wrong-token" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(body).not.toContain("wrong-token");
    expect(body).not.toContain(TOKEN);
  });

  test("accepts the token as a bearer header", async () => {
    const { request, created } = trackedRouter(TOKEN);

    expect((await request("/api/devices", { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await request("/api", { headers: { authorization: `bearer ${TOKEN}` } })).status).toBe(200);
    expect(created).toEqual([SERIAL]);
  });

  test("accepts the token as a query parameter, for callers that cannot set a header", async () => {
    const { request } = trackedRouter(TOKEN);

    expect((await request(`/api/devices?token=${TOKEN}`)).status).toBe(200);
  });

  test("refuses a wrong token in either place", async () => {
    const { request } = trackedRouter(TOKEN);

    expect((await request("/api/devices", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await request("/api/devices?token=nope")).status).toBe(401);
    expect((await request(`/api/devices?token=${TOKEN}x`)).status).toBe(401);
  });

  // A browser cannot attach the token to a preflight; it carries no live state.
  test("answers the WebRTC statistics preflight without the token", async () => {
    const { request } = trackedRouter(TOKEN);

    expect((await request("/webrtc/stats", { method: "OPTIONS" })).status).toBe(204);
  });

  // The router answers these with CORS headers that allow `Authorization`, so a
  // cross-origin client must get past the preflight to send its bearer.
  test("answers the WebRTC signaling preflights without the token or a device", async () => {
    const { request, created } = trackedRouter(TOKEN, [ALLOWED_ORIGIN]);

    for (const path of ["/webrtc/offer", "/webrtc/close"]) {
      const { path: target, ...init } = preflight(path);
      const response = await request(target, init);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
      expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    }
    expect(created).toEqual([]);
  });

  test("refuses a WebRTC signaling preflight from an origin it does not allow", async () => {
    const { request, created } = trackedRouter(TOKEN, [ALLOWED_ORIGIN]);
    const { path, ...init } = preflight("/webrtc/offer", "https://elsewhere.example");

    const response = await request(path, init);

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(created).toEqual([]);
  });

  test("lets an allowed origin read the refusal", async () => {
    const { request } = trackedRouter(TOKEN, [ALLOWED_ORIGIN]);

    const allowed = await request("/api/metrics", { headers: { Origin: ALLOWED_ORIGIN } });
    const other = await request("/api/metrics", { headers: { Origin: "https://elsewhere.example" } });

    expect(allowed.status).toBe(401);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(other.status).toBe(401);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// serve-sim's middleware does the same, so `@expo/hub-client` works from another origin on both.
describe("createRouter CORS policy", () => {
  test("lets an allowed origin read every route, not only WebRTC and SSE", async () => {
    const { request } = trackedRouter(undefined, [ALLOWED_ORIGIN]);

    for (const path of ["/api/devices", `/api?device=${SERIAL}`, `/api/foreground?device=${SERIAL}`]) {
      const allowed = await request(path, { headers: { Origin: ALLOWED_ORIGIN } });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
      expect(allowed.headers.get("vary")).toBe("Origin");
    }
  });

  // A cache must not replay a copy without the policy to an origin that is allowed one.
  test("names no origin for another page, but varies every response on Origin", async () => {
    const { request } = trackedRouter(undefined, [ALLOWED_ORIGIN]);

    const other = await request("/api/devices", { headers: { Origin: "https://elsewhere.example" } });
    const sameOrigin = await request("/api/devices");

    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(other.headers.get("vary")).toBe("Origin");
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(sameOrigin.headers.get("vary")).toBe("Origin");
  });

  test("lets a loopback page read a loopback router without configuration", async () => {
    const { router } = trackedRouter();

    const response = await router.handleRequest(
      new Request("http://127.0.0.1:3400/api/devices", { headers: { Origin: "http://localhost:5173" } }),
    );

    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  test("lets an allowed origin change device state and read a refused change", async () => {
    const { router } = trackedRouter(undefined, [ALLOWED_ORIGIN]);
    const post = (origin: string) =>
      router.handleRequest(
        new Request(`http://127.0.0.1:3400/api/orientation?device=${SERIAL}`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ orientation: "landscape" }),
        }),
      );

    const allowed = await post(ALLOWED_ORIGIN);
    const loopback = await post("http://localhost:5173");

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    // A loopback page may read, but only a configured origin may change state.
    expect(loopback.status).toBe(403);
    expect(loopback.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  test("answers a preflight on any route before the token gate and without a device", async () => {
    const { request, created } = trackedRouter(TOKEN, [ALLOWED_ORIGIN]);

    for (const path of ["/api/orientation", "/api/stream-mode", "/api/devices", "/api/camera/back"]) {
      const { path: target, ...init } = preflight(path);
      const response = await request(target, init);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
      expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
      expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
    }
    expect(created).toEqual([]);
  });

  test("refuses a preflight from an origin it does not allow", async () => {
    const { request, created } = trackedRouter(TOKEN, [ALLOWED_ORIGIN]);
    const { path, ...init } = preflight("/api/orientation", "https://elsewhere.example");

    const response = await request(path, init);

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(created).toEqual([]);
  });
});

describe("authorizeUpgrade with a session token", () => {
  const { router } = trackedRouter(TOKEN);

  // Browser clients hard-code this prefix, so it is part of the wire contract.
  test("names the token subprotocol prefix clients offer", () => {
    expect(SESSION_TOKEN_SUBPROTOCOL_PREFIX).toBe("serve-emu.token.");
  });

  test("accepts a bearer header", () => {
    expect(router.authorizeUpgrade(upgrade({ Authorization: `Bearer ${TOKEN}` }))).toBe(true);
  });

  test("accepts the token subprotocol, alone or among others", () => {
    expect(router.authorizeUpgrade(upgrade({ "Sec-WebSocket-Protocol": `serve-emu.token.${TOKEN}` }))).toBe(true);
    expect(
      router.authorizeUpgrade(
        upgrade({ "Sec-WebSocket-Protocol": `chat, serve-emu.token.stale, serve-emu.token.${TOKEN}` }),
      ),
    ).toBe(true);
  });

  test("refuses an upgrade with no token, a wrong token, or another package's prefix", () => {
    expect(router.authorizeUpgrade(upgrade())).toBe(false);
    expect(router.authorizeUpgrade(upgrade({ Authorization: "Bearer nope" }))).toBe(false);
    expect(router.authorizeUpgrade(upgrade({ "Sec-WebSocket-Protocol": "serve-emu.token.nope" }))).toBe(false);
    expect(router.authorizeUpgrade(upgrade({ "Sec-WebSocket-Protocol": `serve-sim.token.${TOKEN}` }))).toBe(false);
  });

  // Proxy and tunnel access logs record query strings, so a socket never takes the token there.
  // Only the first few token subprotocols are compared, so a long list of guesses costs little.
  test("compares only the first four token subprotocols it is offered", () => {
    const guesses = Array.from({ length: 50 }, (_, i) => `serve-emu.token.guess-${i}`);
    expect(
      router.authorizeUpgrade(
        upgrade({ "Sec-WebSocket-Protocol": [...guesses, `serve-emu.token.${TOKEN}`].join(", ") }),
      ),
    ).toBe(false);
    expect(
      router.authorizeUpgrade(
        upgrade({ "Sec-WebSocket-Protocol": [...guesses.slice(0, 3), `serve-emu.token.${TOKEN}`].join(", ") }),
      ),
    ).toBe(true);
  });

  test("refuses the token in the query string", () => {
    expect(router.authorizeUpgrade(upgrade({}, `?token=${TOKEN}`))).toBe(false);
  });
});

describe("attachWebSocket with a session token", () => {
  // A transport that skips `authorizeUpgrade` must not get an open socket.
  test("closes a socket whose upgrade request is missing or has no token", async () => {
    const { router, attached } = trackedRouter(TOKEN);
    await router.ensure(SERIAL);

    for (const request of [undefined, upgrade(), upgrade({ Authorization: "Bearer nope" })]) {
      const { socket, closes } = closableSocket();
      router.attachWebSocket(socket, { serial: SERIAL, frameMeta: false, ...(request ? { request } : {}) });
      expect(closes).toEqual([[1008, "Unauthorized"]]);
    }
    expect(attached).toEqual([]);
  });

  test("attaches a socket whose upgrade request carries the token", async () => {
    const { router, attached } = trackedRouter(TOKEN);
    await router.ensure(SERIAL);
    const { socket, closes } = closableSocket();

    router.attachWebSocket(socket, {
      serial: SERIAL,
      frameMeta: false,
      request: upgrade({ "Sec-WebSocket-Protocol": `serve-emu.token.${TOKEN}` }),
    });

    expect(closes).toEqual([]);
    expect(attached).toEqual([SERIAL]);
  });
});
