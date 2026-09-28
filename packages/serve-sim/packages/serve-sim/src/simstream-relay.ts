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
 * Message: `{ type: "pipe", port, request, head }` with the socket as the IPC handle, where
 * `request` is the rewritten HTTP upgrade request for the engine and `head` (base64) the bytes the
 * main process had already read past the headers.
 */
import { type Socket } from "net";
import { relaySocket } from "./simstream-pipe.js";

interface PipeMessage {
  type: "pipe";
  port: number;
  request: string;
  head: string;
}

if (process.send) {
  process.on("message", (message: PipeMessage, socket?: Socket) => {
    if (message?.type !== "pipe" || !socket) return;
    relaySocket(socket, message.port, message.request, Buffer.from(message.head, "base64"));
  });
  // Exit with the parent: the IPC channel closes when serve-sim goes away.
  process.on("disconnect", () => process.exit(0));
  process.send({ type: "ready" });
}
