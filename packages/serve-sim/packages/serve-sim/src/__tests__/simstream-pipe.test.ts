import { describe, expect, test } from "bun:test";
import { createServer, connect, type AddressInfo, type Socket } from "net";
import { relaySocket } from "../simstream-pipe";

function listen(onSocket: (socket: Socket) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(onSocket);
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}

describe("relaySocket", () => {
  test("sends the rewritten request and head first, then pipes both ways", async () => {
    let engineReceived = "";
    const engine = await listen((socket) => {
      socket.on("data", (chunk) => {
        engineReceived += chunk.toString();
        if (engineReceived.includes("from-browser")) socket.write("from-engine");
      });
    });
    const front = await listen((socket) => relaySocket(socket, engine.port, "GET /stream HTTP/1.1\r\n\r\n", Buffer.from("HEAD")));

    const browser = connect(front.port, "127.0.0.1");
    const reply = await new Promise<string>((resolve) => {
      browser.on("data", (chunk) => resolve(chunk.toString()));
      browser.on("connect", () => setTimeout(() => browser.write("from-browser"), 50));
    });

    expect(engineReceived.startsWith("GET /stream HTTP/1.1\r\n\r\nHEAD")).toBe(true);
    expect(engineReceived.endsWith("from-browser")).toBe(true);
    expect(reply).toBe("from-engine");
    browser.destroy();
    front.close();
    engine.close();
  });
});
