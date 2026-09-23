import { expect, test } from "bun:test";
import { recordDuoHingeCommand, type DuoHingeCommands } from "../client/simulator/duo-hinge-commands";
import { createAcknowledgedControlQueue, type AcknowledgedControlRequest } from "../client/utils/acknowledged-control-queue";
import type { HingeControlCommand } from "../hinge-control";

test("coalescing native angle requests never records the discarded panel departure", () => {
  let history: DuoHingeCommands = { pending: false, coverDepartures: 0, innerDepartures: 0 };
  const sent: AcknowledgedControlRequest<HingeControlCommand>[] = [];
  const queue = createAcknowledgedControlQueue<HingeControlCommand>({
    send: (request) => { sent.push(request); history = recordDuoHingeCommand(history, request.command); return true; },
    onPendingChange: (pending) => { history = { ...history, pending }; },
  });
  queue.enqueue({ control: "angle", value: 40 }, { key: "angle" });
  queue.enqueue({ control: "angle", value: 55 }, { key: "angle" });
  queue.enqueue({ control: "angle", value: 54 }, { key: "angle" });
  queue.receive({ requestId: sent[0]!.requestId, ok: true });
  expect(sent.map(({ command }) => command.value)).toEqual([40, 54]);
  expect(history).toEqual({ pending: true, coverDepartures: 0, innerDepartures: 2 });
  queue.receive({ requestId: sent[1]!.requestId, ok: true });
  expect(history.pending).toBe(false);
});

test("actual away and return submissions retain both departures in the final history", () => {
  const initial = { pending: true, coverDepartures: 0, innerDepartures: 0 };
  const away = recordDuoHingeCommand(initial, { control: "angle", value: 55 });
  const returned = recordDuoHingeCommand(away, { control: "angle", value: 0 });
  expect(returned).toEqual({ pending: true, coverDepartures: 1, innerDepartures: 1 });
});

test("submitted pose commands choose their own panel and manual hinge edits retain Tent", () => {
  const initial = { pending: false, coverDepartures: 0, innerDepartures: 0 };
  expect(recordDuoHingeCommand(initial, { control: "angle", value: 80 }, "tent").coverDepartures).toBe(0);
  expect(recordDuoHingeCommand(initial, { control: "pose", value: "open" }, "tent").coverDepartures).toBe(1);
  expect(recordDuoHingeCommand(initial, { control: "pose", value: "tent" }).innerDepartures).toBe(1);
  expect(recordDuoHingeCommand(initial, { control: "table", value: true })).toBe(initial);
  expect(recordDuoHingeCommand(initial, { control: "angle", value: 54.5 })).toBe(initial);
});
