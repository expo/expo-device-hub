import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "http";
import { connectToFetch } from "../connect-to-fetch";
import { localPortOf } from "../request-local-port";
import { servePreview } from "../runtime";
import { nodeRequestToWeb } from "../runtime-utils";

async function localPortSeenBy(request: Request): Promise<number | undefined> {
  let seen: number | undefined;
  await connectToFetch((req, res) => {
    seen = req.socket.localPort;
    res.end();
  }, request);
  return seen;
}

describe("the preview server's local port in the middleware", () => {
  test("comes from the socket when a tunnel's Host header has no port", async () => {
    const nodeReq = {
      method: "GET",
      url: "/grid/api/status",
      headers: { host: "web-preview-example.eas-simulator.ngrok.dev" },
      socket: { localPort: 51675 },
    } as unknown as IncomingMessage;

    expect(await localPortSeenBy(nodeRequestToWeb(nodeReq))).toBe(51675);
  });

  test("comes from the URL for a plain fetch Request", async () => {
    expect(await localPortSeenBy(new Request("http://127.0.0.1:3200/grid/api/status"))).toBe(3200);
  });

  test("is the public port when servePreview answers, also through Bun's front server", async () => {
    let seen: number | undefined;
    const server = await servePreview({
      port: 0,
      host: "127.0.0.1",
      middleware: async (request: Request) => {
        seen = localPortOf(request);
        return new Response("ok");
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/grid/api/status`);
      expect(await response.text()).toBe("ok");
      expect(seen).toBe(server.port);
    } finally {
      server.stop();
    }
  });
});
