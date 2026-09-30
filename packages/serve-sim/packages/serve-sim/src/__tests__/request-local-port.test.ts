import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "http";
import { connectToFetch } from "../connect-to-fetch";
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
});
