import { createHash } from "crypto";
import { createServer } from "http";
import type { Socket } from "net";
import WebSocket from "ws";
import { rawHidSocket } from "../../socket/server-input";

// Bundled for Node by the parent test: no TypeScript stripping or Bun net implementation.
const reason = "Simulator input unavailable; retry after other clients disconnect";
const server = createServer();
const sockets = new Set<Socket>();
let messages = 0;
let closes = 0;
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.on("upgrade", (request, socket, head) => {
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const hid = rawHidSocket(socket as Socket, head);
  hid.on("close", () => { closes++; });
  hid.on("message", () => {
    messages++;
    hid.close(1013, reason);
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP listener has no address");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  try {
    const result = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Rejection did not reach the WebSocket peer")), 3_000);
      client.on("error", reject);
      client.on("close", (code, closeReason) => {
        clearTimeout(deadline);
        resolve({ code, reason: closeReason.toString() });
      });
      client.on("open", () => {
        // Both input messages arrive while the server is beginning its rejection.
        // Only the first may reach DeviceSession's message callbacks.
        client.send(Buffer.from([0x03]));
        client.send(Buffer.from([0x03]));
      });
    });
    console.log(JSON.stringify({ ...result, messages, closes }));
  } finally {
    client.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
