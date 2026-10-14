/**
 * The simstream video relay: a small child process that owns every simstream WebSocket.
 *
 * serve-sim's main process does a lot of synchronous work (simctl, plutil, defaults) that can
 * block its event loop for hundreds of milliseconds, sometimes seconds. The video used to be piped
 * through that loop, so every block stalled frames and acks, the engine read the stall as
 * congestion, and quality collapsed. The main process now hands each upgraded socket here over IPC
 * (see `pipeSimstreamUpgrade`), and this process pipes browser ⇄ engine on an event loop that does
 * nothing else.
 *
 * Messages, each with the socket as the IPC handle (`head`, base64, is the bytes the main process
 * had already read past the headers):
 *   - `{ type: "pipe", port, request, head }`: the WebSocket transport. `request` is the rewritten
 *     HTTP upgrade request for the engine; bytes are piped both ways.
 *   - `{ type: "rtp", port, headers, head, iceServers }`: the WebRTC (RTP) transport. The socket is
 *     the browser's signaling WebSocket, upgraded here, and `bridgeSimstreamRtp` joins the engine.
 */
import { type IncomingMessage } from "http";
import { type Socket } from "net";
import { WebSocketServer } from "ws";
import { relaySocket } from "./simstream-pipe.js";
import { bridgeSimstreamRtp } from "./simstream-rtp.js";

type RelayMessage =
  | { type: "pipe"; port: number; request: string; head: string }
  | { type: "rtp"; port: number; headers: IncomingMessage["headers"]; head: string; iceServers: string[] };

if (process.send) {
  const signaling = new WebSocketServer({ noServer: true });
  process.on("message", (message: RelayMessage, socket?: Socket) => {
    if (!socket) return;
    const head = Buffer.from(message.head, "base64");
    if (message.type === "pipe") relaySocket(socket, message.port, message.request, head);
    if (message.type === "rtp") {
      const request = { method: "GET", headers: message.headers } as IncomingMessage;
      signaling.handleUpgrade(request, socket, head, (signal) => bridgeSimstreamRtp(signal, message.port, message.iceServers));
    }
  });
  // Exit with the parent: the IPC channel closes when serve-sim goes away.
  process.on("disconnect", () => process.exit(0));
  process.send({ type: "ready" });
}
