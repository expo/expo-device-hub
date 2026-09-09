import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  ControlInputQueue,
  type ControlBinaryWriter,
  type ControlInputClock,
} from "../src/control-input-queue.ts";
import type { ScrcpySession } from "../src/scrcpy.ts";
import {
  startServer,
  type ServerDependencies,
} from "../src/server.ts";

const IMMEDIATE_CLOCK: ControlInputClock = {
  async sleep(_ms, signal) {
    if (signal.aborted) throw signal.reason;
  },
};

type PendingWrite = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

class ControlledWriter implements ControlBinaryWriter {
  readonly packets: Buffer[] = [];
  pending: PendingWrite | null = null;
  #blockNext = false;
  #failNext = false;
  #closed: Error | null = null;

  blockNextWrite(): void {
    this.#blockNext = true;
  }

  failNextWrite(): void {
    this.#failNext = true;
  }

  write(packet: Buffer, signal: AbortSignal): Promise<void> {
    this.packets.push(Buffer.from(packet));
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.reject(new Error("injected control writer failure"));
    }
    if (!this.#blockNext) return Promise.resolve();
    this.#blockNext = false;

    return new Promise<void>((resolve, reject) => {
      const pending: PendingWrite = {
        resolve,
        reject,
        signal,
        onAbort: () => {},
      };
      pending.onAbort = () => {
        if (this.pending !== pending) return;
        this.pending = null;
        signal.removeEventListener("abort", pending.onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
      this.pending = pending;
      if (signal.aborted) pending.onAbort();
    });
  }

  release(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve();
  }

  close(reason: Error): void {
    if (!this.#closed) this.#closed = reason;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.reject(this.#closed);
  }
}

type FakeSession = ScrcpySession & { readonly closeCount: number };

function fakeSession(serial: string): FakeSession {
  const controlSocket = new EventEmitter();
  const proc = new EventEmitter();
  let closeCount = 0;
  let resolveFrame!: (frame: null) => void;
  const frame = new Promise<null>((resolve) => {
    resolveFrame = resolve;
  });
  const session = {
    transport: "scrcpy",
    meta: {
      deviceName: serial,
      codecId: "h264",
      width: 1080,
      height: 1920,
    },
    protocol: 3,
    videoReader: {},
    controlSocket,
    proc,
    scid: serial.replace(/\W/g, "").slice(0, 8).padEnd(8, "0"),
    localPort: 27_200,
    serial,
    readFrame: () => frame,
    close() {
      closeCount++;
      resolveFrame(null);
    },
    get closeCount() {
      return closeCount;
    },
  };
  return session as unknown as FakeSession;
}

type CapturedServe = {
  serve: typeof Bun.serve;
  server: {
    port: number;
    hostname: string;
    upgrade: (req: Request, options: { data: unknown }) => boolean;
    stop: (closeActiveConnections?: boolean) => void;
  };
  options: () => any;
  upgrades: unknown[];
};

function captureServe(): CapturedServe {
  let captured: any = null;
  const upgrades: unknown[] = [];
  const server = {
    port: 33_001,
    hostname: "127.0.0.1",
    upgrade(_req: Request, options: { data: unknown }) {
      upgrades.push(options.data);
      return true;
    },
    stop() {},
  };
  return {
    serve: ((options: unknown) => {
      captured = options;
      return server;
    }) as typeof Bun.serve,
    server,
    options: () => captured,
    upgrades,
  };
}

type FakeWebSocket = {
  data: any;
  sent: unknown[];
  closes: Array<{ code?: number; reason?: string }>;
  send: (value: string | Buffer) => number;
  close: (code?: number, reason?: string) => void;
  getBufferedAmount: () => number;
};

function fakeWebSocket(data: unknown): FakeWebSocket {
  const sent: unknown[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    data,
    sent,
    closes,
    send(value) {
      if (typeof value === "string") sent.push(JSON.parse(value));
      return 1;
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    getBufferedAmount() {
      return 0;
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness(options: {
  serials?: string[];
  maxDepth?: number;
  maxBytes?: number;
} = {}) {
  const serials = options.serials ?? ["device-a"];
  const sessions = new Map(
    serials.map((serial) => [serial, fakeSession(serial)]),
  );
  const writers = new Map(
    serials.map((serial) => [serial, new ControlledWriter()]),
  );
  const queues = new Map<string, ControlInputQueue>();
  const captured = captureServe();
  const dependencies: ServerDependencies = {
    startScrcpy: async ({ serial }) => {
      const session = sessions.get(serial);
      if (!session) throw new Error(`missing fake session ${serial}`);
      return session;
    },
    listAllDevices: async () =>
      serials.map((serial) => ({ serial, state: "device" })),
    serve: captured.serve,
    createInputQueue: (session) => {
      const writer = writers.get(session.serial);
      if (!writer) throw new Error(`missing fake writer ${session.serial}`);
      const queue = new ControlInputQueue({
        writer,
        clock: IMMEDIATE_CLOCK,
        maxDepth: options.maxDepth,
        maxBytes: options.maxBytes,
      });
      queues.set(session.serial, queue);
      return queue;
    },
  };
  const started = await startServer(
    { serial: serials[0]!, port: 33_001 },
    dependencies,
  );
  const handlers = captured.options();

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const result = await handlers.fetch(
      new Request(`http://127.0.0.1:33001${path}`, init),
      captured.server,
    );
    if (!(result instanceof Response)) {
      throw new Error(`${path} did not return a Response`);
    }
    return result;
  };

  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const openWebSocket = async (): Promise<FakeWebSocket> => {
    const result = await handlers.fetch(
      new Request("http://127.0.0.1:33001/ws"),
      captured.server,
    );
    expect(result).toBeUndefined();
    const data = captured.upgrades.at(-1);
    if (!data) throw new Error("WebSocket upgrade data was not captured");
    const ws = fakeWebSocket(data);
    handlers.websocket.open(ws);
    return ws;
  };

  return {
    started,
    handlers,
    request,
    post,
    openWebSocket,
    sessions,
    writers,
    queues,
  };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message = "condition was not met",
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe("server control input integration", () => {
  test("records normalized gestures in enqueue order before completion", async () => {
    const harness = await createHarness();
    const writer = harness.writers.get("device-a")!;
    try {
      writer.blockNextWrite();
      const swipeResponse = harness.post("/api/swipe", {
        x1: 0.1,
        y1: 0.8,
        x2: 0.9,
        y2: 0.2,
        durationMs: 80,
      });
      await waitFor(() => writer.pending !== null, "swipe did not start");

      const textResponse = harness.post("/api/text", {
        text: "a".repeat(301),
      });
      let snapshot: any;
      await waitFor(async () => {
        snapshot = await json(await harness.request("/api/session"));
        return snapshot.events.length === 2;
      }, "accepted inputs were not recorded");

      expect(snapshot.events.map((event: any) => event.gesture.type)).toEqual([
        "swipe",
        "text",
      ]);
      expect(snapshot.events[1].gesture.text).toBe("a".repeat(300));

      writer.release();
      const [swipe, text] = await Promise.all([swipeResponse, textResponse]);
      expect(await json(swipe)).toMatchObject({
        ok: true,
        status: "completed",
      });
      expect(await json(text)).toMatchObject({
        ok: true,
        status: "completed",
      });
    } finally {
      writer.release();
      harness.started.stop();
    }
  });

  test("returns a structured 429 when the queue rejects admission", async () => {
    const harness = await createHarness({ maxDepth: 1 });
    const writer = harness.writers.get("device-a")!;
    try {
      writer.blockNextWrite();
      const first = harness.post("/api/tap", { x: 0.2, y: 0.3 });
      await waitFor(() => writer.pending !== null, "first tap did not start");

      const rejected = await harness.post("/api/tap", { x: 0.4, y: 0.5 });
      expect(rejected.status).toBe(429);
      expect(await json(rejected)).toMatchObject({
        ok: false,
        status: "rejected",
        code: "control-queue-overloaded",
      });
      const snapshot = await json(await harness.request("/api/session"));
      expect(snapshot.events).toHaveLength(1);

      writer.release();
      expect(await json(await first)).toMatchObject({
        ok: true,
        status: "completed",
      });
    } finally {
      writer.release();
      harness.started.stop();
    }
  });

  test("reports WebSocket completion, coalescing, and failure while honoring ack:false", async () => {
    const harness = await createHarness();
    const writer = harness.writers.get("device-a")!;
    const queue = harness.queues.get("device-a")!;
    try {
      const ws = await harness.openWebSocket();
      await waitFor(
        () => writer.packets.length === 1 && queue.snapshot().depth === 0,
        "initial reset-video packet did not drain",
      );

      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 66 }),
      );
      await waitFor(() => ws.sent.length === 1, "completed ACK missing");
      expect(ws.sent[0]).toMatchObject({ ok: true, status: "completed" });

      writer.blockNextWrite();
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "tap", x: 0.5, y: 0.5, ack: false }),
      );
      await waitFor(() => writer.pending !== null, "tap did not block");
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({
          type: "touch",
          action: "move",
          x: 0.2,
          y: 0.2,
          pointerId: 1,
        }),
      );
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({
          type: "touch",
          action: "move",
          x: 0.8,
          y: 0.8,
          pointerId: 1,
        }),
      );
      await waitFor(() => queue.snapshot().depth === 3, "moves did not queue");
      writer.release();
      await waitFor(() => ws.sent.length === 3, "move ACKs missing");
      expect(ws.sent.slice(1)).toEqual([
        { ok: true, status: "coalesced" },
        { ok: true, status: "completed" },
      ]);

      writer.failNextWrite();
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 20 }),
      );
      await waitFor(() => ws.sent.length === 4, "failure ACK missing");
      expect(ws.sent[3]).toMatchObject({
        ok: false,
        status: "failed",
        code: "control-dispatch-failed",
      });

      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 21, ack: false }),
      );
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "not-a-gesture", ack: false }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ws.sent).toHaveLength(4);
    } finally {
      writer.release();
      harness.started.stop();
    }
  });

  test("rejects a reset-video request during cooldown after the input queue fails", async () => {
    const harness = await createHarness();
    const writer = harness.writers.get("device-a")!;
    const queue = harness.queues.get("device-a")!;
    try {
      const ws = await harness.openWebSocket();
      await waitFor(
        () => writer.packets.length === 1 && queue.snapshot().depth === 0,
        "initial reset-video packet did not drain",
      );

      writer.failNextWrite();
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 20 }),
      );
      await waitFor(() => ws.sent.length === 1, "failure ACK missing");
      expect(ws.sent[0]).toMatchObject({
        ok: false,
        status: "failed",
        code: "control-dispatch-failed",
      });
      expect(queue.snapshot().closed).toBe(true);

      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "reset-video" }),
      );
      await waitFor(() => ws.sent.length === 2, "reset rejection ACK missing");
      expect(ws.sent[1]).toMatchObject({
        ok: false,
        status: "rejected",
        code: "control-dispatch-failed",
      });
    } finally {
      writer.release();
      harness.started.stop();
    }
  });

  test("switching rejects old pending work without writing it to the new session", async () => {
    const harness = await createHarness({ serials: ["device-a", "device-b"] });
    const oldWriter = harness.writers.get("device-a")!;
    const newWriter = harness.writers.get("device-b")!;
    try {
      oldWriter.blockNextWrite();
      const oldInput = harness.post("/api/tap", { x: 0.25, y: 0.75 });
      await waitFor(() => oldWriter.pending !== null, "old tap did not start");

      const switched = await harness.post("/api/devices/select", {
        serial: "device-b",
      });
      expect(await json(switched)).toMatchObject({
        ok: true,
        serial: "device-b",
      });

      const cancelled = await oldInput;
      expect(cancelled.status).toBe(503);
      expect(await json(cancelled)).toMatchObject({
        ok: false,
        status: "failed",
        code: "control-queue-closed",
      });
      expect(oldWriter.packets).toHaveLength(1);
      expect(newWriter.packets).toHaveLength(0);

      oldWriter.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(oldWriter.packets).toHaveLength(1);

      const next = await harness.post("/api/key", { key: "home" });
      expect(await json(next)).toMatchObject({
        ok: true,
        status: "completed",
      });
      expect(newWriter.packets).toHaveLength(2);
      expect(oldWriter.packets).toHaveLength(1);

      const snapshot = await json(await harness.request("/api/session"));
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0].gesture).toEqual({ type: "home" });
      expect(harness.sessions.get("device-a")!.closeCount).toBe(1);
    } finally {
      oldWriter.release();
      newWriter.release();
      harness.started.stop();
    }
  });
});
