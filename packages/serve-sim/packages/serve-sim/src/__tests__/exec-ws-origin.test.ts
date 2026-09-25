import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { simMiddleware } from "../middleware";
import { accessCookieName } from "../session-auth";
import { servePreview, type PreviewServer } from "../runtime";
import { freePortAsync, useTempStateDir } from "./helpers";

const TOKEN = "exec-ws-origin-token";

let previewPort: number;
let gatedPort: number;
let tempState: ReturnType<typeof useTempStateDir>;
let server: PreviewServer;
let gatedServer: PreviewServer;

beforeAll(async () => {
  tempState = useTempStateDir();
  previewPort = await freePortAsync();
  gatedPort = await freePortAsync();
  server = await servePreview({
    port: previewPort,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      execToken: TOKEN,
      device: "DEVICE-A",
      corsOrigins: ["https://expo.dev", "https://*.staging.expo.dev", "https://expo.test:13001"],
    }),
  });
  gatedServer = await servePreview({
    port: gatedPort,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      execToken: TOKEN,
      device: "DEVICE-A",
      corsOrigins: ["https://expo.dev"],
      requirePreviewToken: true,
    }),
  });
});

afterAll(() => {
  server?.stop(true);
  gatedServer?.stop(true);
  tempState?.restore();
});

type Outcome = "ready" | "refused" | "hung";

function connect(
  origin: string | null,
  {
    port = previewPort,
    token = TOKEN,
    subprotocol = true,
    headers = {},
  }: { port?: number; token?: string; subprotocol?: boolean; headers?: Record<string, string> } = {},
): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/exec-ws`,
      subprotocol ? [`serve-sim.token.${token}`] : [],
      { headers: origin ? { Origin: origin, ...headers } : headers },
    );
    let settled = false;
    const settle = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle("hung"), 3000);
    ws.on("message", (raw) => {
      settle((JSON.parse(String(raw)) as { ready?: boolean }).ready === true ? "ready" : "refused");
    });
    ws.on("close", () => settle("refused"));
    ws.on("error", () => settle("refused"));
  });
}

describe("exec-ws origin policy", () => {
  test("lets a configured origin open the channel with a valid token", async () => {
    expect(await connect("https://expo.dev")).toBe("ready");
  });

  test("matches a configured origin by wildcard, so deploy previews connect", async () => {
    expect(await connect("https://pr-31018.staging.expo.dev")).toBe("ready");
  });

  test("keeps the port, so a dev server on another port is not the configured one", async () => {
    expect(await connect("https://expo.test:13001")).toBe("ready");
    expect(await connect("https://expo.test:13002")).toBe("refused");
  });

  test("refuses an origin nobody configured", async () => {
    expect(await connect("https://evil.test")).toBe("refused");
    expect(await connect("https://expo.dev.evil.test")).toBe("refused");
  });

  test("refuses another loopback port, which CORS would have allowed", async () => {
    expect(await connect("http://localhost:3000")).toBe("refused");
  });

  test("refuses the literal null a sandboxed document sends", async () => {
    expect(await connect("null")).toBe("refused");
  });

  test("still accepts the page serve-sim serves itself", async () => {
    expect(await connect(`http://127.0.0.1:${previewPort}`)).toBe("ready");
  });

  test("refuses a scheme no browser sends, even on the server's own host", async () => {
    expect(await connect(`ws://127.0.0.1:${previewPort}`)).toBe("refused");
  });

  test("still accepts a client that sends no Origin at all", async () => {
    expect(await connect(null)).toBe("ready");
  });

  test("leaves a configured origin with no credential waiting for a first-frame token", async () => {
    expect(await connect("https://expo.dev", { subprotocol: false })).toBe("hung");
  });

  test("refuses a configured origin offering the wrong token", async () => {
    expect(await connect("https://expo.dev", { token: "wrong-token" })).toBe("refused");
  });
});

describe("exec-ws origin policy, token gate on", () => {
  test("a configured origin opens it with the token subprotocol", async () => {
    expect(await connect("https://expo.dev", { port: gatedPort })).toBe("ready");
  });

  test("refuses a configured origin presenting only the access cookie", async () => {
    const headers = { Cookie: `${accessCookieName(TOKEN)}=${TOKEN}` };
    expect(await connect("https://expo.dev", { port: gatedPort, subprotocol: false, headers })).toBe(
      "refused",
    );
    expect(await connect("https://evil.test", { port: gatedPort, subprotocol: false, headers })).toBe(
      "refused",
    );
  });

  test("refuses a configured origin with no credential at all", async () => {
    expect(await connect("https://expo.dev", { port: gatedPort, subprotocol: false })).toBe("refused");
  });
});
