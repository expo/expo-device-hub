import { createHash } from "crypto";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { acceptedTokenSubprotocol } from "../session-auth";

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Complete the server side of a WebSocket upgrade by hand (the `ws` server's
 * handshake doesn't flush under Bun). Writes the 101 response and resumes the
 * socket on success; on a missing key writes 400 and returns false.
 */
export function writeWebSocketAccept(req: IncomingMessage, socket: Socket, execToken: string): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return false;
  }
  const accept = createHash("sha1").update(key + WS_ACCEPT_GUID).digest("base64");
  // A client that offered subprotocols fails the handshake unless one is named back.
  const subprotocol = acceptedTokenSubprotocol(req.headers, execToken);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    (subprotocol ? `Sec-WebSocket-Protocol: ${subprotocol}\r\n` : "") +
    "\r\n",
  );
  socket.resume();
  return true;
}
