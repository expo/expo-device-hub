import { describe, expect, test } from "bun:test";
import {
  createAcknowledgedControlQueue,
  type AcknowledgedControlReply,
  type AcknowledgedControlRequest,
} from "../client/utils/acknowledged-control-queue";

type Command = { angle?: number; tilt?: number; pose?: string };

function setup(timeoutMs = 1_000) {
  const sent: AcknowledgedControlRequest<Command>[] = [];
  const pending: boolean[] = [];
  const results: { command: Command; reply: AcknowledgedControlReply }[] = [];
  const errors: { message: string; command: Command }[] = [];
  let connected = true;
  const queue = createAcknowledgedControlQueue<Command>({
    send(request) {
      if (!connected) return false;
      sent.push(request);
      return true;
    },
    onPendingChange: (value) => pending.push(value),
    onResult: (command, reply) => results.push({ command, reply }),
    onError: (message, command) => errors.push({ message, command }),
    timeoutMs,
  });
  return { queue, sent, pending, results, errors, disconnect: () => { connected = false; } };
}

describe("acknowledged control queue", () => {
  test("waits for each acknowledgement and coalesces intermediate slider values", () => {
    const { queue, sent, pending, results } = setup();
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.enqueue({ angle: 100 }, { key: "angle" });
    queue.enqueue({ angle: 110 }, { key: "angle" });
    expect(sent).toEqual([{ requestId: 1, command: { angle: 90 } }]);
    expect(pending).toEqual([true]);

    expect(queue.receive({ requestId: 1, ok: true })).toBe(true);
    expect(sent).toEqual([
      { requestId: 1, command: { angle: 90 } },
      { requestId: 2, command: { angle: 110 } },
    ]);
    expect(pending).toEqual([true]);
    queue.receive({ requestId: 2, ok: true });
    expect(pending).toEqual([true, false]);
    expect(results.map(({ command }) => command)).toEqual([{ angle: 90 }, { angle: 110 }]);
  });

  test("keeps different controls in their original queue order when coalescing", () => {
    const { queue, sent } = setup();
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.enqueue({ tilt: 10 }, { key: "tilt" });
    queue.enqueue({ angle: 100 }, { key: "angle" });
    queue.enqueue({ tilt: 20 }, { key: "tilt" });
    queue.receive({ requestId: 1, ok: true });
    queue.receive({ requestId: 2, ok: true });
    queue.receive({ requestId: 3, ok: true });
    expect(sent.map(({ command }) => command)).toEqual([
      { angle: 90 },
      { tilt: 20 },
      { angle: 100 },
    ]);
  });

  test("replaces queued slider changes with a pose while awaiting the active command", () => {
    const { queue, sent } = setup();
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.enqueue({ angle: 100 }, { key: "angle" });
    queue.enqueue({ tilt: 20 }, { key: "tilt" });
    queue.enqueue({ pose: "laptop" }, { key: "pose", replaceQueued: true });
    queue.enqueue({ angle: 120 }, { key: "angle" });
    queue.receive({ requestId: 1, ok: true });
    queue.receive({ requestId: 2, ok: true });
    queue.receive({ requestId: 3, ok: true });
    expect(sent.map(({ command }) => command)).toEqual([
      { angle: 90 },
      { pose: "laptop" },
      { angle: 120 },
    ]);
  });

  test("ignores duplicate and stale replies without releasing a newer command", () => {
    const { queue, sent, results, pending } = setup();
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.enqueue({ angle: 100 }, { key: "angle" });
    expect(queue.receive({ requestId: 99, ok: true })).toBe(false);
    queue.receive({ requestId: 1, ok: true });
    expect(queue.receive({ requestId: 1, ok: false, error: "Old failure" })).toBe(false);
    expect(results).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(pending).toEqual([true]);
    queue.receive({ requestId: 2, ok: true });
  });

  test("clears queued work on a device switch and never reuses request IDs", () => {
    const { queue, sent, pending, errors } = setup();
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.enqueue({ tilt: 10 }, { key: "tilt" });
    queue.clear();
    queue.enqueue({ pose: "book" }, { key: "pose" });
    expect(queue.receive({ requestId: 1, ok: true })).toBe(false);
    queue.receive({ requestId: 2, ok: true });
    expect(sent).toEqual([
      { requestId: 1, command: { angle: 90 } },
      { requestId: 2, command: { pose: "book" } },
    ]);
    expect(pending).toEqual([true, false, true, false]);
    expect(errors).toEqual([]);
  });

  test("discards the remaining queue if sending fails after a disconnect", () => {
    const { queue, sent, pending, errors, disconnect } = setup();
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.enqueue({ angle: 100 }, { key: "angle" });
    queue.enqueue({ tilt: 10 }, { key: "tilt" });
    disconnect();
    queue.receive({ requestId: 1, ok: true });
    expect(sent).toHaveLength(1);
    expect(pending).toEqual([true, false]);
    expect(errors).toEqual([{ message: "Device is disconnected.", command: { angle: 100 } }]);
    expect(queue.receive({ requestId: 2, ok: true })).toBe(false);
  });

  test("reports rejected commands and discards dependent queued updates", () => {
    const { queue, sent, pending, results, errors } = setup();
    queue.enqueue({ pose: "tent" }, { key: "pose" });
    queue.enqueue({ tilt: 10 }, { key: "tilt" });
    queue.receive({ requestId: 1, ok: false, error: "Pose is unsupported" });
    expect(sent).toHaveLength(1);
    expect(pending).toEqual([true, false]);
    expect(results).toEqual([
      { command: { pose: "tent" }, reply: { requestId: 1, ok: false, error: "Pose is unsupported" } },
    ]);
    expect(errors).toEqual([{ message: "Pose is unsupported", command: { pose: "tent" } }]);
  });

  test("times out without replaying queued changes and accepts fresh input afterward", async () => {
    const { queue, sent, pending, errors } = setup(10);
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.enqueue({ tilt: 10 }, { key: "tilt" });
    await Bun.sleep(30);
    expect(pending).toEqual([true, false]);
    expect(errors).toEqual([{ message: "Device control timed out.", command: { angle: 90 } }]);
    expect(sent).toHaveLength(1);
    expect(queue.receive({ requestId: 1, ok: true })).toBe(false);
    queue.enqueue({ pose: "book" }, { key: "pose" });
    queue.receive({ requestId: 2, ok: true });
    expect(sent.map(({ command }) => command)).toEqual([{ angle: 90 }, { pose: "book" }]);
  });

  test("cancels the acknowledgement timeout when cleared", async () => {
    const { queue, pending, errors } = setup(10);
    queue.enqueue({ angle: 90 }, { key: "angle" });
    queue.clear();
    queue.clear();
    await Bun.sleep(30);
    expect(pending).toEqual([true, false]);
    expect(errors).toEqual([]);
  });
});
