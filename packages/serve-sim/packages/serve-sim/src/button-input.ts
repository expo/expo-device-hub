import WebSocket from "ws";
import { onCliInputReady } from "./socket/cli-input";

export type ButtonPayload = {
  button: string;
  page?: number;
  usage?: number;
  phase?: "down" | "up" | "press";
};

// @ref LLP 0003#input-actions — a checked button fails the socket's next barrier instead of being swallowed.
export function sendButtonToWs(
  state: { wsUrl: string; token?: string; inputAdmission?: boolean },
  payload: ButtonPayload,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      state.wsUrl,
      state.token ? { headers: { Authorization: `Bearer ${state.token}` } } : undefined,
    );
    let settled = false;
    let awaitingBarrier = false;
    const timeout = setTimeout(
      () => finish(new Error("Simulator button did not finish. Try again.")),
      10_000,
    );

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        ws.terminate();
        reject(error);
      } else {
        ws.close();
        resolve();
      }
    }

    onCliInputReady(
      ws,
      state.inputAdmission === true,
      () => {
        try {
          ws.send(
            Buffer.concat([
              Buffer.from([0x04]),
              Buffer.from(JSON.stringify({ ...payload, checked: true })),
            ]),
          );
          awaitingBarrier = true;
          ws.send(Uint8Array.of(0x11));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      },
      finish,
    );
    ws.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x91 || !awaitingBarrier) return;
      if (frame.length === 2 && frame[1] === 1) finish();
      else
        finish(
          new Error(
            "Simulator button input failed. The button may not have reached the simulator.",
          ),
        );
    });
    ws.on("close", (code, reason) =>
      finish(
        new Error(
          `Simulator button interrupted (${code}${reason.length ? `: ${reason}` : ""}). The button may not have reached the simulator.`,
        ),
      ),
    );
    ws.on("error", () => finish(new Error("Simulator button connection failed.")));
  });
}
