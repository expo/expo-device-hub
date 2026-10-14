import type WebSocket from "ws";
import { WS_MSG_INPUT_ADMITTED } from "./input-protocol";

// @ref LLP 0003#cli-input-admission — require slot admission while preserving older helpers.
/** Opening the transport does not prove the server reserved an input slot. */
export function onCliInputReady(
  socket: WebSocket,
  requireAdmission: boolean,
  send: () => void,
  reject: (error: Error) => void,
  timeoutMs = 10_000,
): void {
  let ready = false;
  const timer = setTimeout(() => {
    reject(new Error(`Simulator input was not admitted within ${timeoutMs / 1000} seconds. Try again shortly.`));
    socket.terminate();
  }, timeoutMs);
  const admit = () => {
    if (ready) return;
    ready = true;
    clearTimeout(timer);
    try {
      send();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      socket.terminate();
    }
  };
  socket.on("open", () => {
    if (!requireAdmission) admit();
  });
  socket.on("message", data => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.from(data as Buffer);
    if (bytes.length === 1 && bytes[0] === WS_MSG_INPUT_ADMITTED) admit();
  });
  socket.on("close", (code, reason) => {
    clearTimeout(timer);
    if (code === 1013) {
      reject(new Error(`Simulator input rejected: ${reason.toString() || "server busy"}. Try again shortly.`));
    } else if (!ready) {
      reject(new Error(`Simulator input closed before admission (${code}). Try again shortly.`));
    }
  });
  socket.on("error", () => clearTimeout(timer));
}
