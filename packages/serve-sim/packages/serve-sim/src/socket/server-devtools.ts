import type { IncomingMessage } from "http";
import type { Socket } from "net";
// The middleware can run on Node 20, which has no global WebSocket client.
import { WebSocket } from "ws";
import { parseWebSocketFrame, sendBrowserFrame, websocketFrame } from "./frames";
import { writeWebSocketAccept } from "./server-upgrade";

type PendingWebSocketFrame = {
  opcode: number;
  payload: Buffer<ArrayBufferLike>;
};

function webSocketBinary(payload: Buffer<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(payload.length);
  bytes.set(payload);
  return bytes;
}

export function bridgeWebSocketFrames(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  upstreamUrl: string,
  execToken: string,
): void {
  if (!writeWebSocketAccept(req, socket, execToken)) return;

  const upstream = new WebSocket(upstreamUrl);
  upstream.binaryType = "arraybuffer";
  let upstreamOpen = false;
  let closed = false;
  let pendingToUpstream: PendingWebSocketFrame[] = [];
  let buffered = Buffer.from(head);

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    try { upstream.close(); } catch {}
    try { socket.end(websocketFrame(0x8, Buffer.alloc(0))); } catch {}
    try { socket.destroy(); } catch {}
  };

  const sendToUpstream = (frame: PendingWebSocketFrame) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame.opcode === 0x1 ? frame.payload.toString("utf8") : webSocketBinary(frame.payload));
      return;
    }
    pendingToUpstream.push({ opcode: frame.opcode, payload: Buffer.from(frame.payload) });
  };

  const drainFrames = () => {
    try {
      while (buffered.length > 0) {
        const frame = parseWebSocketFrame(buffered);
        if (!frame) break;
        buffered = buffered.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          sendBrowserFrame(socket, 0x8, frame.payload);
          closeBoth();
          return;
        }
        if (frame.opcode === 0x9) {
          sendBrowserFrame(socket, 0xA, frame.payload);
          continue;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          sendToUpstream({ opcode: frame.opcode, payload: frame.payload });
        }
      }
    } catch {
      closeBoth();
    }
  };

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const frame of pendingToUpstream) {
      upstream.send(frame.opcode === 0x1 ? frame.payload.toString("utf8") : webSocketBinary(frame.payload));
    }
    pendingToUpstream = [];
  };
  upstream.onmessage = (event) => {
    const data = event.data;
    const payload = typeof data === "string"
      ? Buffer.from(data)
      : Buffer.from(data as ArrayBuffer);
    sendBrowserFrame(socket, typeof data === "string" ? 0x1 : 0x2, payload);
  };
  upstream.onerror = closeBoth;
  upstream.onclose = closeBoth;

  socket.on("data", (chunk) => {
    if (typeof chunk === "string") chunk = Buffer.from(chunk);
    buffered = Buffer.concat([buffered, chunk]);
    drainFrames();
  });
  socket.on("error", closeBoth);
  socket.on("close", closeBoth);
  drainFrames();
}
