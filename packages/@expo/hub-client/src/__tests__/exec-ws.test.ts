import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { hostUiRequest, runHostAction } from "../exec-ws";
import { createControlSocket } from "../control-socket";

/**
 * Minimal scripted WebSocket: records frames the client sends and lets the
 * test answer them. Installed on `globalThis` for the duration of a test.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  reply(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const realWebSocket = globalThis.WebSocket;

function installFakeWebSocket() {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
}

afterEach(() => {
  (globalThis as any).WebSocket = realWebSocket;
});

/** Drive the auth handshake: expect `{token}` first, answer `{ready}`, return the request frame. */
async function handshake(token: string): Promise<{ ws: FakeWebSocket; request: any }> {
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeWebSocket.instances[0]!;
  expect(JSON.parse(ws.sent[0]!)).toEqual({ token });
  ws.reply({ ready: true });
  return { ws, request: JSON.parse(ws.sent[1]!) };
}

describe("runHostAction", () => {
  test.each([
    ["app.install", false],
    ["app.install", true],
    ["upload.append", false],
    ["upload.append", true],
  ] as const)(
    "uses the host install deadline and bounds uploads (%s, pooled=%s)",
    async (action, pooled) => {
      installFakeWebSocket();
      const realSet = globalThis.setTimeout;
      const realClear = globalThis.clearTimeout;
      const timers = new Map<ReturnType<typeof setTimeout>, { run(): void; delay: number }>();
      const set = spyOn(globalThis, "setTimeout").mockImplementation(((
        run: (...args: unknown[]) => void,
        delay: number | undefined,
        ...args: unknown[]
      ) => {
        const timer = realSet(run, delay, ...args);
        timers.set(timer, { run: () => run(...args), delay: delay ?? 0 });
        return timer;
      }) as typeof setTimeout);
      const clear = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
        timers.delete(timer as ReturnType<typeof setTimeout>);
        realClear(timer as ReturnType<typeof setTimeout>);
      });
      const channel = pooled
        ? createControlSocket("ws://hub/exec-ws", "secret", { healthIntervalMs: 60_000 })
        : undefined;
      try {
        const pending = runHostAction(
          "ws://hub/exec-ws",
          "secret",
          action,
          { udid: "U", uploadId: "app.tgz" },
          undefined,
          channel,
        );
        const outcome = pending.catch((error) => error);
        const { ws, request } = await handshake("secret");
        // Advance active client deadlines through a 25-second host install.
        for (const [timer, task] of [...timers]) {
          if (task.delay > 0 && task.delay <= 25_000) {
            clearTimeout(timer);
            task.run();
          }
        }
        ws.reply({ id: request.id, stdout: "installed", stderr: "", exitCode: 0 });
        if (action === "app.install")
          expect(await outcome).toEqual({ stdout: "installed", stderr: "", exitCode: 0 });
        else expect(await outcome).toEqual(new Error("exec-ws timeout"));
      } finally {
        channel?.dispose();
        for (const timer of timers.keys()) realClear(timer);
        clear.mockRestore();
        set.mockRestore();
      }
    },
  );

  test.each([false, true])(
    "rejects an install when its connection fails (pooled=%s)",
    async (pooled) => {
      installFakeWebSocket();
      const channel = pooled ? createControlSocket("ws://hub/exec-ws", "secret") : undefined;
      try {
        const pending = runHostAction(
          "ws://hub/exec-ws",
          "secret",
          "app.install",
          { udid: "U" },
          undefined,
          channel,
        );
        const outcome = pending.catch((error) => error);
        const { ws } = await handshake("secret");
        ws.onclose?.();
        expect(await outcome).toEqual(new Error("exec-ws closed"));
      } finally {
        channel?.dispose();
      }
    },
  );

  test("authenticates, sends a typed action frame, and resolves the result", async () => {
    installFakeWebSocket();
    const pending = runHostAction("ws://hub/exec-ws", "secret", "app.container", {
      udid: "UDID",
      bundleId: "com.example.app",
    });
    const { ws, request } = await handshake("secret");
    // `{id, action, params}` — serve-sim's action protocol, never `{command}`.
    expect(request).toEqual({
      id: 1,
      action: "app.container",
      params: { udid: "UDID", bundleId: "com.example.app" },
    });
    ws.reply({ id: 1, stdout: "/path/Foo.app\n", stderr: "", exitCode: 0 });
    expect(await pending).toEqual({ stdout: "/path/Foo.app\n", stderr: "", exitCode: 0 });
    expect(ws.closed).toBe(true);
  });

  test("bounds a standalone install handshake before the host action starts", async () => {
    installFakeWebSocket();
    const realSet = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((
      run: () => void,
      delay?: number,
    ) => {
      if (delay === 5_000) expire = run;
      timer = realSet(run, delay);
      return timer;
    }) as typeof setTimeout);
    const outcome = runHostAction("ws://hub/exec-ws", "secret", "app.install", { udid: "U" }).catch(
      (error) => error,
    );
    try {
      expect(expire).toBeDefined();
      expire!();
      expect(await outcome).toEqual(new Error("exec-ws timeout"));
      const ws = FakeWebSocket.instances[0]!;
      ws.reply({ ready: true });
      expect(ws.sent.some((frame) => JSON.parse(frame).action === "app.install")).toBe(false);
    } finally {
      FakeWebSocket.instances[0]?.onclose?.();
      clearTimeout(timer);
      set.mockRestore();
      await outcome;
    }
  });

  test("maps a rejected action to a failed result instead of throwing", async () => {
    installFakeWebSocket();
    const pending = runHostAction("ws://hub/exec-ws", "secret", "app.container", { udid: "-x" });
    const { ws } = await handshake("secret");
    ws.reply({ id: 1, error: "app.container: udid must be a simulator udid or device name" });
    expect(await pending).toEqual({
      stdout: "",
      stderr: "app.container: udid must be a simulator udid or device name",
      exitCode: 1,
    });
  });

  test("rejects when the socket closes before answering", async () => {
    installFakeWebSocket();
    const pending = runHostAction("ws://hub/exec-ws", "secret", "app.container", { udid: "U" });
    const { ws } = await handshake("secret");
    ws.onclose?.();
    await expect(pending).rejects.toThrow("exec-ws closed");
  });
});

describe("hostUiRequest", () => {
  test("sends a setting once despite repeated or late authentication frames", async () => {
    installFakeWebSocket();
    const pending = hostUiRequest("ws://hub/exec-ws", "secret", {
      device: "UDID",
      option: "liquid-glass",
      value: "clear",
    });
    const { ws, request } = await handshake("secret");
    ws.reply({ ready: true });
    expect(ws.sent).toHaveLength(2);
    expect(request).toEqual({
      id: 1,
      ui: { device: "UDID", option: "liquid-glass", value: "clear" },
    });
    ws.reply({ id: 1, ok: true });
    expect(await pending).toEqual({ ok: true });
    ws.reply({ ready: true });
    expect(ws.sent).toHaveLength(2);
  });

  test("reads the simulator settings status", async () => {
    installFakeWebSocket();
    const pending = hostUiRequest("ws://hub/exec-ws", "secret", { device: "UDID" });
    const { ws, request } = await handshake("secret");
    expect(request).toEqual({ id: 1, ui: { device: "UDID" } });
    ws.reply({ id: 1, status: { appearance: "dark", "hardware-keyboard": "off" } });
    expect(await pending).toEqual({
      status: { appearance: "dark", "hardware-keyboard": "off" },
    });
  });

  test("rejects with the server message when a write is refused", async () => {
    installFakeWebSocket();
    const pending = hostUiRequest("ws://hub/exec-ws", "secret", {
      device: "UDID",
      option: "hardware-keyboard",
      value: "sideways",
    });
    const { ws } = await handshake("secret");
    ws.reply({ id: 1, error: "invalid value for hardware-keyboard: sideways" });
    await expect(pending).rejects.toThrow("invalid value for hardware-keyboard: sideways");
  });
});
