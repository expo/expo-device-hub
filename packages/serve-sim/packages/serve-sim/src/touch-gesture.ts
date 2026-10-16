import WebSocket from "ws";
import { z } from "zod";
import { onCliInputReady } from "./socket/cli-input";

export const TouchCoordinate = z.number().finite().min(0).max(1);
const DEFAULT_STEP_DELAY_MS = 40;
function delayBeforeEvent(event: { delayMs?: number }, index: number): number {
  return event.delayMs ?? (index === 0 ? 0 : DEFAULT_STEP_DELAY_MS);
}
const TouchEvent = z.object({
  type: z.enum(["begin", "move", "end"]),
  x: TouchCoordinate,
  y: TouchCoordinate,
  edge: z.number().int().min(0).max(4).optional(),
  delayMs: z.number().int().min(0).max(1000).optional(),
});

export const TouchGesture = z.array(TouchEvent).min(2).max(256).refine(
  (events) => events[0]?.type === "begin" && events.at(-1)?.type === "end" &&
    events.slice(1, -1).every((event) => event.type === "move"),
  "must start with begin, contain only moves, and finish with end",
).refine(
  (events) => events.reduce((total, event, index) => total + delayBeforeEvent(event, index), 0) <= 30_000,
  "total delay must be at most 30000 ms",
);

// @ref LLP 0003#input-actions — keep the complete gesture on one admitted socket until its barrier completes.
export function sendTouchGestureToWs(
  state: { wsUrl: string; token?: string; inputAdmission?: boolean },
  events: z.infer<typeof TouchGesture>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(state.wsUrl, state.token
      ? { headers: { Authorization: `Bearer ${state.token}` } }
      : undefined);
    let settled = false;
    let awaitingBarrier = false;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let finishDelay: (() => void) | undefined;
    const timeout = setTimeout(() => finish(new Error("Simulator gesture did not finish. Try again.")),
      10_000 + events.reduce((total, event, index) => total + delayBeforeEvent(event, index), 0));

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(delayTimer);
      finishDelay?.();
      if (error) {
        ws.terminate();
        reject(error);
      } else {
        ws.close();
        resolve();
      }
    }

    async function send() {
      try {
        for (const [index, { delayMs, ...event }] of events.entries()) {
          const waitMs = delayBeforeEvent({ delayMs }, index);
          if (waitMs) await new Promise<void>((done) => {
            finishDelay = done;
            delayTimer = setTimeout(done, waitMs);
          });
          if (settled || ws.readyState !== WebSocket.OPEN) return;
          ws.send(Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify(event))]));
        }
        awaitingBarrier = true;
        ws.send(Uint8Array.of(0x11));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }

    onCliInputReady(ws, state.inputAdmission === true, () => { void send(); }, finish);
    ws.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x91 || !awaitingBarrier) return;
      if (frame.length === 2 && frame[1] === 1) finish();
      else finish(new Error("Simulator gesture input failed. Some input may not have been delivered."));
    });
    ws.on("close", (code, reason) => finish(new Error(
      `Simulator gesture interrupted (${code}${reason.length ? `: ${reason}` : ""}). Some input may not have been delivered.`,
    )));
    ws.on("error", () => finish(new Error("Simulator gesture connection failed.")));
  });
}
