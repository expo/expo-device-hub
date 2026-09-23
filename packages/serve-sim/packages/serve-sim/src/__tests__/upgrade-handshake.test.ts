import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "net";
import { simMiddleware, type WebKitBridge } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { freePortAsync } from "./helpers";

const TOKEN = "s3cret-token";
const TARGET = encodeURIComponent("sim:page:1");

describe("upgrade handshake", () => {
  let preview: PreviewServer | null = null;
  let cdp: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    preview?.stop(true);
    preview = null;
    cdp?.stop(true);
    cdp = null;
  });

  async function startPreview(): Promise<number> {
    const cdpPort = await freePortAsync();
    cdp = Bun.serve({
      hostname: "127.0.0.1",
      port: cdpPort,
      fetch(req, server) {
        if (server.upgrade(req, { data: undefined })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    const bridge: WebKitBridge = {
      port: cdpPort,
      cdpUrl: `ws://127.0.0.1:${cdpPort}`,
      listTargets: async () => [],
    };
    const port = await freePortAsync();
    preview = await servePreview({
      port,
      middleware: simMiddleware({
        basePath: "/",
        proxyHelpers: true,
        requirePreviewToken: true,
        execToken: TOKEN,
        inspectWebKitBridge: async () => bridge,
      }),
      host: "127.0.0.1",
    });
    return port;
  }

  function handshake(port: number, subprotocol: string | null): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /devtools/page/${TARGET} HTTP/1.1\r\n`
          + `Host: 127.0.0.1:${port}\r\n`
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
          + "Sec-WebSocket-Version: 13\r\n"
          + (subprotocol ? `Sec-WebSocket-Protocol: ${subprotocol}\r\n` : "")
          + "\r\n",
        );
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("handshake timed out"));
      }, 5_000);
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString("utf-8");
        if (received.includes("\r\n\r\n")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(received);
        }
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(received);
      });
    });
  }

  test("names the token subprotocol back, which a ws client requires", async () => {
    const port = await startPreview();

    const response = await handshake(port, `serve-sim.token.${TOKEN}`);

    expect(response).toContain("101 Switching Protocols");
    expect(response).toContain(`Sec-WebSocket-Protocol: serve-sim.token.${TOKEN}`);
  });

  test("refuses the upgrade when no credential is offered", async () => {
    const port = await startPreview();

    const response = await handshake(port, null);

    expect(response).toBe("");
  });
});
