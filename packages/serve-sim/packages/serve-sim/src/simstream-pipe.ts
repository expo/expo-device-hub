import { connect, type Socket } from "net";

/**
 * Pipes an upgraded browser socket to a simstream engine on 127.0.0.1:`port`, sending the
 * rewritten upgrade `request` and any `head` bytes first. Used by the relay process, and in-process
 * as a fallback when the relay can't run.
 */
export function relaySocket(socket: Socket, port: number, request: string, head: Buffer): void {
  const upstream = connect(port, "127.0.0.1");
  upstream.setNoDelay(true);
  socket.setNoDelay(true);
  upstream.once("connect", () => {
    upstream.write(request);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.once("error", close);
  socket.once("error", close);
  upstream.once("close", close);
  socket.once("close", close);
}
