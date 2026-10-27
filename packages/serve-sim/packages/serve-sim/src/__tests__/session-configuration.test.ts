import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
import { timeStartup } from "../startup-timing";
import { type SessionConfiguration } from "../session-configuration";
import { type StreamSettings } from "../stream-settings";
import { type UpgradeHandlerWebSocket } from "../socket/types";
import { recordState, useTempStateDir } from "./helpers";
import type { SimMiddlewareOptions } from "../middleware";

const DEVICE = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const OTHER = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

const configuration: SessionConfiguration = {
  stream: {
    transport: "webrtc",
    codec: "h264",
    iceServers: [{ urls: ["turn:relay.example:3478"], username: "job", credential: "secret" }],
    mjpegFps: 60,
    mjpegQuality: 0.7,
    maxDimension: 0,
    h264Bitrate: 6000000,
    h264Fps: 60,
  },
  corsOrigins: ["https://expo.dev"],
  frameAncestors: ["https://expo.dev"],
  shareUrl: "https://expo.dev/preview/job",
  disableShare: false,
  screenshotsDirectory: "/tmp/owned-job-screenshots",
  networkCapture: false,
  networkCaptureFields: [],
};

async function host(
  configureResources: (value: SessionConfiguration) => Promise<void> = async () => {},
  options: Partial<SimMiddlewareOptions> = {},
) {
  const streamSettings: StreamSettings = { transport: "webrtc", codec: "h264" };
  const middleware = await timeStartup("preview-middleware", () =>
    simMiddleware({
      basePath: "/",
      execToken: "owner-token",
      requirePreviewToken: true,
      loopbackOnly: true,
      streamSettings,
      configureResources,
      ...options,
    }),
  );
  const request = async (method = "GET", headers: Record<string, string> = {}, body?: unknown) => {
    const response = await middleware(
      new Request("http://127.0.0.1:3200/session", {
        method,
        headers: { Authorization: "Bearer owner-token", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    if (!response) return new Response("not found", { status: 404 });
    return response;
  };
  const configure = (value: SessionConfiguration) => middleware.configureSession(value);
  return { request, configure, streamSettings, middleware };
}

describe("prepared process session configuration", () => {
  let state: ReturnType<typeof useTempStateDir>;
  beforeAll(() => {
    state = useTempStateDir();
  });
  afterAll(() => state.restore());

  for (const singleDevice of [DEVICE, undefined]) {
    test(`existing execution sockets use the adopted policy (single-device=${!!singleDevice})`, async () => {
      const { configure, middleware } = await host(async () => {}, {
        device: DEVICE,
        prepareForAdoption: true,
      });
      let receive!: (data: string) => void;
      const replies: { error?: string }[] = [];
      const socket: UpgradeHandlerWebSocket = {
        OPEN: 1,
        readyState: 1,
        send(data) {
          replies.push(JSON.parse(String(data)));
        },
        on(event, handler) {
          if (event === "message") receive = handler as typeof receive;
        },
        close() {},
      };
      middleware.handleWebSocket?.(
        new Request("http://127.0.0.1:3200/exec-ws", {
          headers: { "Sec-WebSocket-Protocol": "serve-sim.token.owner-token" },
        }),
        socket,
      );
      const subscribe = (sub: number) =>
        receive(JSON.stringify({ sub, path: `/not-allowed?device=${OTHER}` }));
      subscribe(1);
      expect(replies.at(-1)?.error).toContain("single-device");
      await configure({ ...configuration, singleDevice });
      subscribe(2);
      expect(replies.at(-1)?.error).toContain(singleDevice ? "single-device" : "path not allowed");
    });
  }

  test("pins preparation and adopts the same device before native configuration", async () => {
    let middleware: Awaited<ReturnType<typeof host>>["middleware"];
    const foreign = () =>
      middleware(
        new Request(`http://127.0.0.1:3200/api?device=${OTHER}`, {
          headers: { Authorization: "Bearer owner-token" },
        }),
      );
    const server = await host(
      async () => {
        expect((await foreign())?.status).toBe(403);
      },
      { device: DEVICE, prepareForAdoption: true },
    );
    middleware = server.middleware;
    expect((await foreign())?.status).toBe(403);
    await server.configure({ ...configuration, singleDevice: DEVICE.toLowerCase() });
    expect((await foreign())?.status).toBe(403);
    const remove = recordState(DEVICE, process.pid, 1);
    try {
      const api = await middleware(
        new Request("http://127.0.0.1:3200/api", {
          headers: { Authorization: "Bearer owner-token" },
        }),
      );
      expect(await api?.json()).toMatchObject({ singleDevice: DEVICE });
    } finally {
      remove();
    }
    await expect(server.configure(configuration)).rejects.toThrow("cannot be configured");
  });

  test("refuses adoption onto another device before configuring resources", async () => {
    let calls = 0;
    const { configure } = await host(
      async () => {
        calls++;
      },
      {
        device: DEVICE,
        prepareForAdoption: true,
      },
    );
    await expect(configure({ ...configuration, singleDevice: OTHER })).rejects.toThrow(
      "single-device",
    );
    expect(calls).toBe(0);
  });

  test("adoption without a restriction retains normal multi-device behavior", async () => {
    const { configure, middleware } = await host(async () => {}, {
      device: DEVICE,
      prepareForAdoption: true,
    });
    await configure(configuration);
    const response = await middleware(
      new Request(`http://127.0.0.1:3200/api/event-log?device=${OTHER}`, {
        headers: { Authorization: "Bearer owner-token" },
      }),
    );
    expect(response?.status).toBe(200);
    await response?.text();
  });

  test("omitting the adopted policy cannot remove an explicit startup restriction", async () => {
    const { configure, middleware } = await host(async () => {}, {
      device: DEVICE,
      singleDevice: DEVICE,
    });
    await configure(configuration);
    const response = await middleware(
      new Request(`http://127.0.0.1:3200/api?device=${OTHER}`, {
        headers: { Authorization: "Bearer owner-token" },
      }),
    );
    expect(response?.status).toBe(403);
    let closed = false;
    middleware.handleWebSocket?.(
      new Request(`http://127.0.0.1:3200/helper/${OTHER}/ws`, {
        headers: { Authorization: "Bearer owner-token" },
      }),
      {
        on() {},
        close() {
          closed = true;
        },
      } as unknown as UpgradeHandlerWebSocket,
    );
    expect(closed).toBe(true);
  });

  test("never exposes ownership or reconfiguration to HTTP token holders", async () => {
    const { request } = await host();
    for (const method of ["GET", "POST"]) {
      expect(
        (await request(method, {}, method === "POST" ? configuration : undefined)).status,
      ).toBe(404);
      expect(
        (
          await request(
            method,
            { Origin: "https://expo.dev" },
            method === "POST" ? configuration : undefined,
          )
        ).status,
      ).toBe(404);
    }
  });

  test("applies the job policy and TURN settings once before preview use", async () => {
    const received: SessionConfiguration[] = [];
    const { configure, streamSettings, middleware } = await host(async (value) => {
      received.push(value);
    });
    await configure(configuration);
    expect(received).toEqual([configuration]);
    expect(streamSettings.transport === "webrtc" && streamSettings.iceServers).toEqual(
      configuration.stream.iceServers,
    );
    const api = await middleware(
      new Request("http://127.0.0.1:3200/api", {
        headers: { Authorization: "Bearer owner-token", Origin: "https://expo.dev" },
      }),
    );
    expect(api?.headers.get("access-control-allow-origin")).toBe("https://expo.dev");
    await expect(configure(configuration)).rejects.toThrow("cannot be configured");
  });

  test("updates the execution WebSocket origin policy along with HTTP", async () => {
    const { configure, middleware } = await host();
    const attempt = () => {
      let closed = false;
      const socket: UpgradeHandlerWebSocket = {
        OPEN: 1,
        readyState: 1,
        send() {},
        on() {},
        close() {
          closed = true;
        },
      };
      expect(
        middleware.handleWebSocket?.(
          new Request("http://127.0.0.1:3200/exec-ws", {
            headers: {
              Origin: "https://expo.dev",
              "Sec-WebSocket-Protocol": "serve-sim.token.owner-token",
            },
          }),
          socket,
        ),
      ).toBe(true);
      return closed;
    };
    expect(attempt()).toBe(true);
    await configure(configuration);
    expect(attempt()).toBe(false);
  });

  test("reserves concurrent handoffs before awaiting native configuration", async () => {
    let release!: () => void;
    const native = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { configure } = await host(async () => native);
    const first = configure(configuration);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(configure(configuration)).rejects.toThrow("cannot be configured");
    release();
    await first;
  });

  test("leaves failed native handoff unusable so its owner falls back to a fresh process", async () => {
    const { configure } = await host(async () => {
      throw new Error("native preparation failed");
    });
    await expect(configure(configuration)).rejects.toThrow("native preparation failed");
    await expect(configure(configuration)).rejects.toThrow("cannot be configured");
  });
});

test("prepared handoff updates the live encoder rather than only its metadata", async () => {
  const { runChildSuite } = await import("./fixtures/run-child-suite");
  const { exitCode, output } = await runChildSuite("prepared-session.child.ts");
  expect(output).toContain("1 pass");
  expect(exitCode).toBe(0);
}, 30_000);

test("the preview token cannot claim a server through HTTP", async () => {
  let calls = 0;
  const { request } = await host(async () => {
    calls++;
  });
  expect((await request("POST", {}, configuration)).status).toBe(404);
  expect(calls).toBe(0);
});
