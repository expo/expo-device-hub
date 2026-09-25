import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TOKEN = "YWJjZA==";
const SUBPROTOCOL = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface Frame {
  id?: number;
  token?: string;
}

const sentFrames: Frame[] = [];
const constructedWith: string[][] = [];
let socket: FakeSocket;

class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as Frame;
    sentFrames.push(frame);
    if (frame.token === TOKEN) this.reply({ ready: true });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  reply(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let runHostAction: typeof import("../../client/utils/exec").runHostAction;

beforeAll(async () => {
  const globals = globalThis as Record<string, unknown>;
  globals.WebSocket = function BrowserLikeSocket(this: FakeSocket, _url: string, protocols?: string[]) {
    if (protocols?.some((protocol) => !SUBPROTOCOL.test(protocol))) {
      throw new SyntaxError("The subprotocol is invalid.");
    }
    constructedWith.push(protocols ?? []);
    socket = new FakeSocket();
    return socket;
  };
  (globals.WebSocket as { OPEN?: number }).OPEN = 1;
  globals.window = {
    __SIM_PREVIEW__: { execToken: TOKEN, basePath: "/" },
    location: { href: "http://127.0.0.1:3100/", protocol: "http:", host: "127.0.0.1:3100", pathname: "/" },
  };
  ({ runHostAction } = await import("../../client/utils/exec"));
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals.WebSocket;
  delete globals.window;
});

describe("client runHostAction with a token outside the subprotocol charset", () => {
  it("sends the token in the first frame and still runs the action", async () => {
    const call = runHostAction("appearance.get", { udid: "U" });
    while (sentFrames.length < 2) await new Promise((r) => setTimeout(r, 2));
    socket.reply({ id: sentFrames[1]!.id, stdout: "dark", exitCode: 0 });

    expect((await call).stdout).toBe("dark");
    expect(constructedWith).toEqual([[]]);
    expect(sentFrames[0]).toEqual({ token: TOKEN });
  });
});
