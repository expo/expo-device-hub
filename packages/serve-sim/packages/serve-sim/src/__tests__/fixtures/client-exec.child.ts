import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TOKEN = "client-exec-token";

interface Frame {
  id?: number;
  token?: string;
  action?: string;
  ui?: unknown;
  params?: Record<string, unknown>;
}

const sentFrames: Frame[] = [];
const binaryFrames: Uint8Array[] = [];
let socket: FakeSocket;

// Run by client-exec.test.ts in a child process: exec.ts caches its socket at module scope, so any
// earlier file that imports it leaves a connection this file cannot replace.
//
// The page talks to the host only through this socket, so a fake one exercises the whole client
// path: the token handshake, the id/reply pairing, and how a refusal becomes an ExecResult.
class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
      this.reply({ ready: true });
    });
  }

  send(raw: string | Uint8Array): void {
    if (raw instanceof Uint8Array) { binaryFrames.push(raw); return; }
    sentFrames.push(JSON.parse(raw) as Frame);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  reply(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let sendCameraFrame: typeof import("../../client/utils/exec").sendCameraFrame;
let stopCameraFrames: typeof import("../../client/utils/exec").stopCameraFrames;
let onCameraStopped: typeof import("../../client/utils/exec").onCameraStopped;
let onExecDisconnect: typeof import("../../client/utils/exec").onExecDisconnect;
let runHostAction: typeof import("../../client/utils/exec").runHostAction;
let offeredProtocols: string[] = [];

beforeAll(async () => {
  const globals = globalThis as Record<string, unknown>;
  globals.WebSocket = function OpenedSocket(this: FakeSocket, _url: string, protocols?: string[]) {
    socket = new FakeSocket();
    offeredProtocols = protocols ?? [];
    return socket;
  };
  (globals.WebSocket as { OPEN?: number }).OPEN = 1;
  globals.window = {
    __SIM_PREVIEW__: { execToken: TOKEN, basePath: "/" },
    location: { href: "http://127.0.0.1:3100/", protocol: "http:", host: "127.0.0.1:3100", pathname: "/" },
  };
  ({ runHostAction, sendCameraFrame, stopCameraFrames, onExecDisconnect, onCameraStopped } = await import("../../client/utils/exec"));
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals.WebSocket;
  delete globals.window;
});

/** Starts a call, waits for its frame to actually go out, then answers that frame by id. */
async function request(
  start: () => Promise<import("../../client/utils/exec").ExecResult>,
  reply: Record<string, unknown>,
): Promise<import("../../client/utils/exec").ExecResult> {
  const baseline = sentFrames.length;
  const call = start();
  while (sentFrames.length <= baseline) await new Promise((r) => setTimeout(r, 2));
  socket.reply({ id: sentFrames.at(-1)!.id, ...reply });
  return call;
}

describe("client runHostAction", () => {
  it("presents the preview token at the handshake rather than in a frame", async () => {
    await request(() => runHostAction("appearance.get", { udid: "U" }), { stdout: "", exitCode: 0 });
    expect(offeredProtocols).toEqual([`serve-sim.token.${TOKEN}`]);
    expect(sentFrames[0]).toHaveProperty("id");
  });

  it("passes a successful result through unchanged", async () => {
    const result = await request(() => runHostAction("appearance.get", { udid: "U" }), {
      stdout: "dark\n",
      stderr: "",
      exitCode: 0,
    });
    expect(result).toEqual({ stdout: "dark\n", stderr: "", exitCode: 0 });
  });

  // Every migrated tool renders its error banner from this shape, so a refusal has to arrive as a
  // failed result rather than a thrown error or an empty success.
  it("turns a server refusal into a failed result", async () => {
    const result = await request(() => runHostAction("reveal", { path: "/etc/passwd" }), {
      error: "path is outside the paths this preview may read",
    });
    expect(result).toEqual({
      stdout: "",
      stderr: "path is outside the paths this preview may read",
      exitCode: 1,
    });
  });

  it("defaults a reply with no exit code to a failure", async () => {
    const result = await request(() => runHostAction("appearance.get", { udid: "U" }), {
      stdout: "",
    });
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 1 });
  });

  it("sends the action and params the caller asked for", async () => {
    await request(() => runHostAction("button", { value: "home", udid: "U" }), { exitCode: 0 });
    expect(sentFrames.at(-1)).toMatchObject({
      action: "button",
      params: { value: "home", udid: "U" },
    });
  });

  it("sends a binary camera frame with the selected device", () => {
    expect(sendCameraFrame("11111111-2222-3333-4444-555555555555", new Uint8Array([7, 8]))).toBe("sent");
    const frame = binaryFrames.at(-1)!;
    expect(frame[0]).toBe(1);
    expect(new TextDecoder().decode(frame.subarray(2, 2 + frame[1]!))).toBe("11111111-2222-3333-4444-555555555555");
    expect([...frame.subarray(2 + frame[1]!)]).toEqual([7, 8]);
  });

  it("disconnects only the selected browser frame channel", () => {
    stopCameraFrames("11111111-2222-3333-4444-555555555555");
    const frame = binaryFrames.at(-1)!;
    expect(frame[0]).toBe(2);
    expect(frame.length).toBe(2 + frame[1]!);
    expect(new TextDecoder().decode(frame.subarray(2))).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("drops congested camera frames without growing the queue", () => {
    socket.bufferedAmount = 600 * 1024;
    const baseline = binaryFrames.length;
    expect(sendCameraFrame("11111111-2222-3333-4444-555555555555", new Uint8Array([7]))).toBe("dropped");
    expect(binaryFrames).toHaveLength(baseline);
    socket.bufferedAmount = 0;
  });

  it("drops invalid device IDs for both camera frames and stop messages", () => {
    const baseline = binaryFrames.length;
    for (const udid of ["", "DEVICE-A", "x".repeat(36), "a".repeat(64)]) {
      expect(sendCameraFrame(udid, new Uint8Array([7]))).toBe("dropped");
      stopCameraFrames(udid);
    }
    expect(binaryFrames).toHaveLength(baseline);
  });

  it("routes ownership loss only to the matching camera listener", () => {
    let stopped = 0;
    const unsubscribe = onCameraStopped("DEVICE-A", () => { stopped++; });
    socket.reply({ cameraStopped: "DEVICE-B" });
    expect(stopped).toBe(0);
    socket.reply({ cameraStopped: "DEVICE-A" });
    expect(stopped).toBe(1);
    unsubscribe();
    socket.reply({ cameraStopped: "DEVICE-A" });
    expect(stopped).toBe(1);
  });

  // Left last: closing the socket tears down the module's cached connection.
  it("rejects an in-flight request when the socket drops", async () => {
    const baseline = sentFrames.length;
    const call = runHostAction("appearance.get", { udid: "U" });
    while (sentFrames.length <= baseline) await new Promise((r) => setTimeout(r, 2));
    let disconnected = 0;
    const unsubscribe = onExecDisconnect(() => { disconnected++; });
    socket.onerror?.();
    socket.close();
    unsubscribe();
    expect(disconnected).toBe(1);
    expect(sendCameraFrame("DEVICE-A", new Uint8Array([7]))).toBe("disconnected");

    // Raced rather than awaited: if the drop stops rejecting, the promise never settles, and an
    // await would hang the whole run instead of failing this test.
    const outcome = await Promise.race([
      call.then(() => "resolved", (e: Error) => e.message),
      new Promise<string>((r) => setTimeout(() => r("still pending"), 500)),
    ]);
    expect(outcome).toContain("control socket closed");
  }, 5_000);
});
