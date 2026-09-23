import { expect, test } from "bun:test";
import { parseCrashReport } from "../../crash/report";
import { summarizeCrash, type CrashStreamFrame } from "../../crash/protocol";
import { CrashStore } from "../../crash/store";
import { applyCrashFrame, EMPTY_CRASH_LIST } from "../../client/utils/crash-stream";

test("crash frames travel through the exec socket into the list reducer", async () => {
  type SentFrame = { token?: string; sub?: number; unsub?: number; path?: string };
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 1;
    sent: SentFrame[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.onopen?.();
        this.reply({ ready: true });
      });
    }
    send(raw: string) { this.sent.push(JSON.parse(raw) as SentFrame); }
    reply(frame: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  async function subscribed(index: number): Promise<{ socket: FakeSocket; sub: number }> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const socket = sockets[index];
      const subscription = socket?.sent.find((frame) => frame.sub !== undefined);
      if (socket && subscription?.sub !== undefined) return { socket, sub: subscription.sub };
      await Bun.sleep(5);
    }
    throw new Error("The crash client did not subscribe to the exec socket before the deadline.");
  }
  const globals = globalThis as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousWebSocket = globals.WebSocket;
  globals.WebSocket = FakeSocket;
  globals.window = {
    __SIM_PREVIEW__: { execToken: "test-token", basePath: "/" },
    location: { href: "http://localhost/" },
  };
  let stop: (() => void) | undefined;
  try {
    const { watchCrashes } = await import("../../client/utils/watch-crashes");
    const store = new CrashStore();
    const report = parseCrashReport('{"bundleID":"demo","incident_id":"A"}\n{}')!;
    const first = summarizeCrash(store.record(report, "/A.ips"));
    const second = { ...first, id: "B", lastSeen: first.lastSeen + 1 };
    let state = EMPTY_CRASH_LIST;
    let errors = 0;
    stop = watchCrashes("/crashes?device=U&tail=1", (frame) => {
      state = applyCrashFrame(state, frame);
    }, () => { errors += 1; });
    const initial = await subscribed(0);
    expect(initial.socket.sent[0]).toEqual({ token: "test-token" });
    expect(initial.socket.sent.at(-1)?.path).toBe("/crashes?device=U&tail=1");
    const deliver = (socket: FakeSocket, sub: number, frame: CrashStreamFrame) => {
      const data = `data: ${JSON.stringify(frame)}\n\n`;
      socket.reply({ sub, data: data.slice(0, 9) });
      socket.reply({ sub, data: data.slice(9) });
    };
    deliver(initial.socket, initial.sub, { type: "list", crashes: [first] });
    deliver(initial.socket, initial.sub, { type: "crash", record: second });
    expect(state.crashes.map((crash) => crash.id)).toEqual(["B", "A"]);
    initial.socket.reply({ sub: initial.sub, data: 'data: not-json\n\n' });
    expect(state.crashes).toHaveLength(2);
    deliver(initial.socket, initial.sub, { type: "recurred", record: { ...second, count: 2 } });
    expect(state.crashes[0]?.count).toBe(2);
    initial.socket.close();
    expect(errors).toBe(1);
    const reconnected = await subscribed(1);
    deliver(reconnected.socket, reconnected.sub, { type: "list", crashes: [second] });
    expect(state.crashes.map((crash) => crash.id)).toEqual(["B"]);
    deliver(reconnected.socket, reconnected.sub, { type: "evicted", id: "B" });
    expect(state.crashes).toEqual([]);
    stop();
    expect(reconnected.socket.sent.at(-1)).toEqual({ unsub: reconnected.sub });
    deliver(reconnected.socket, reconnected.sub, { type: "crash", record: first });
    expect(state.crashes).toEqual([]);
  } finally {
    stop?.();
    for (const socket of sockets) socket.close();
    globals.window = previousWindow;
    globals.WebSocket = previousWebSocket;
  }
}, 10_000);
