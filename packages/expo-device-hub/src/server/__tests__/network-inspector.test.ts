import { describe, expect, test } from "bun:test";

import { NETWORK_MAX_REQUESTS, type NetworkServerMessage } from "../../network-protocol";
import {
  adaptWebSocket,
  type CdpSocket,
  NetworkSession,
  type NetworkSessionDeps,
  type NetworkSocket,
  networkWebSocketHandler,
  parseNetworkDeviceRef,
} from "../network-inspector";
import { type InspectorTarget } from "../network-targets";

type Listener = (...args: any[]) => void;

class Emitter {
  listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** The app's inspector, as seen through Metro. It accepts only `acceptedOrigin`, like Expo CLI. */
class FakeCdp extends Emitter implements CdpSocket {
  sent: any[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly origin: string,
    readonly acceptedOrigin: string,
  ) {
    super();
    queueMicrotask(() => {
      if (origin !== acceptedOrigin) {
        this.emit("open");
        this.close();
        return;
      }
      this.emit("open");
    });
  }
  send(data: string) {
    const message = JSON.parse(data);
    this.sent.push(message);
    if (message.method === "Network.enable") queueMicrotask(() => this.reply(message.id, {}));
  }
  reply(id: number, result: unknown) {
    this.emit("message", JSON.stringify({ id, result }));
  }
  event(method: string, params: unknown) {
    this.emit("message", JSON.stringify({ method, params }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeClient extends Emitter implements NetworkSocket {
  messages: NetworkServerMessage[] = [];
  closedWith: number | undefined;
  send(data: string) {
    this.messages.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
    this.emit("close");
  }
  last<T extends NetworkServerMessage["type"]>(type: T) {
    return this.messages.filter((m) => m.type === type).at(-1) as
      | Extract<NetworkServerMessage, { type: T }>
      | undefined;
  }
}

const DEVICE = { platform: "ios" as const, id: "UDID", name: "iPhone Duo", version: "iOS 27.1" };
const TARGET: InspectorTarget = {
  id: "1",
  deviceName: "iPhone Duo (iOS 27.1)",
  appId: "com.example.app",
  webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=abc&page=1",
};

function setup({ targets = [TARGET], acceptedOrigin = "http://127.0.0.1:8081" } = {}) {
  const sockets: FakeCdp[] = [];
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  let listed = targets;
  const deps: NetworkSessionDeps = {
    listTargets: async () => listed,
    deviceNames: async () => ["iPhone Duo (iOS 27.1)"],
    connect: (url, origin) => {
      const socket = new FakeCdp(url, origin, acceptedOrigin);
      sockets.push(socket);
      return socket;
    },
    now: () => 1_000,
    setTimeout: ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as NetworkSessionDeps["setTimeout"],
    clearTimeout: ((timer: any) => {
      if (timer) timer.cancelled = true;
    }) as NetworkSessionDeps["clearTimeout"],
  };
  let idled = false;
  const session = new NetworkSession(DEVICE, "http://127.0.0.1:8081", () => (idled = true), deps);
  const runPoll = async () => {
    const poll = timers.filter((t) => !t.cancelled && t.delay === 2_000).at(-1);
    if (!poll) return;
    poll.cancelled = true;
    poll.callback();
    await settle();
  };
  return {
    session,
    sockets,
    timers,
    setTargets: (next: InspectorTarget[]) => (listed = next),
    runPoll,
    idled: () => idled,
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("NetworkSession", () => {
  test("attaches to the device's app with the origin Metro accepts", async () => {
    const { session, sockets } = setup({ acceptedOrigin: "http://localhost:8081" });
    const client = new FakeClient();
    session.subscribe(client);
    await settle();

    expect(sockets.map((s) => s.origin)).toEqual([
      "http://127.0.0.1:8081",
      "http://localhost:8081",
    ]);
    expect(sockets[1]!.url).toBe("ws://127.0.0.1:8081/inspector/debug?device=abc&page=1");
    expect(client.last("status")?.status).toEqual({
      state: "attached",
      app: { id: "com.example.app", deviceName: "iPhone Duo (iOS 27.1)" },
    });
  });

  test("turns Network events into redacted requests", async () => {
    const { session, sockets } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    const cdp = sockets[0]!;

    cdp.event("Network.requestWillBeSent", {
      requestId: "r1",
      timestamp: 10,
      wallTime: 1_700_000_000,
      type: "Fetch",
      request: {
        url: "https://api.example.com/items",
        method: "POST",
        headers: { Authorization: "Bearer x" },
        postData: "{}",
      },
    });
    cdp.event("Network.responseReceived", {
      requestId: "r1",
      response: {
        status: 201,
        statusText: "Created",
        mimeType: "application/json",
        headers: { "Set-Cookie": "s=1", Server: "x" },
      },
    });
    cdp.event("Network.loadingFinished", {
      requestId: "r1",
      timestamp: 10.25,
      encodedDataLength: 512,
    });

    expect(client.last("request")?.request).toEqual({
      id: "1.r1",
      method: "POST",
      url: "https://api.example.com/items",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_250,
      status: 201,
      statusText: "Created",
      mimeType: "application/json",
      resourceType: "Fetch",
      encodedDataLength: 512,
      failed: undefined,
      requestHeaders: { Authorization: "[REDACTED]" },
      responseHeaders: { "Set-Cookie": "[REDACTED]", Server: "x" },
      requestBody: "{}",
    });
  });

  test("reports failures and cancellations", async () => {
    const { session, sockets } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    const cdp = sockets[0]!;
    cdp.event("Network.requestWillBeSent", {
      requestId: "a",
      request: { url: "https://x", method: "GET" },
    });
    cdp.event("Network.loadingFailed", { requestId: "a", errorText: "net::ERR_NAME_NOT_RESOLVED" });
    cdp.event("Network.requestWillBeSent", {
      requestId: "b",
      request: { url: "https://y", method: "GET" },
    });
    cdp.event("Network.loadingFailed", { requestId: "b", canceled: true });

    const requests = client.messages
      .filter((m) => m.type === "request")
      .map((m) => (m as any).request);
    expect(requests.find((r) => r.id === "1.a" && r.failed)?.failed).toBe(
      "net::ERR_NAME_NOT_RESOLVED",
    );
    expect(requests.find((r) => r.id === "1.b" && r.failed)?.failed).toBe("Canceled");
  });

  test("applies headers that arrive before their request", async () => {
    const { session, sockets } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    const cdp = sockets[0]!;
    cdp.event("Network.requestWillBeSentExtraInfo", {
      requestId: "r1",
      headers: { Cookie: "s=1", Accept: "*/*" },
    });
    cdp.event("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://x", method: "GET", headers: { Accept: "text/html" } },
    });
    expect(client.last("request")?.request.requestHeaders).toEqual({
      Accept: "*/*",
      Cookie: "[REDACTED]",
    });
  });

  test("lists each redirect hop as its own request", async () => {
    const { session, sockets } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    const cdp = sockets[0]!;
    cdp.event("Network.requestWillBeSent", {
      requestId: "r1",
      timestamp: 10,
      wallTime: 1_700_000_000,
      request: { url: "http://x/old", method: "GET" },
    });
    cdp.event("Network.requestWillBeSent", {
      requestId: "r1",
      timestamp: 10.1,
      wallTime: 1_700_000_000.1,
      request: { url: "https://x/new", method: "GET" },
      redirectResponse: { status: 301, statusText: "Moved Permanently", headers: {} },
    });
    cdp.event("Network.responseReceived", { requestId: "r1", response: { status: 200 } });

    const late = new FakeClient();
    session.subscribe(late);
    const snapshot = late.last("snapshot")!.requests;
    expect(snapshot.map((r) => [r.id, r.url, r.status])).toEqual([
      ["1.r1", "http://x/old", 301],
      ["1.r1~1", "https://x/new", 200],
    ]);
    expect(snapshot[0]!.finishedAt).toBe(1_700_000_000_100);
  });

  test("keeps ids from an earlier connection distinct and their bodies unasked", async () => {
    const { session, sockets, runPoll } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    sockets[0]!.event("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://x/first" },
    });
    sockets[0]!.close();
    await runPoll();
    const second = sockets.at(-1)!;
    expect(second).not.toBe(sockets[0]);
    second.event("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://x/second" },
    });

    const late = new FakeClient();
    session.subscribe(late);
    expect(late.last("snapshot")!.requests.map((r) => [r.id, r.url])).toEqual([
      ["1.r1", "https://x/first"],
      ["2.r1", "https://x/second"],
    ]);

    client.emit("message", JSON.stringify({ type: "get-response-body", id: "1.r1" }));
    await settle();
    expect(second.sent.some((m) => m.method === "Network.getResponseBody")).toBe(false);
    expect(client.last("response-body")?.error).toContain("earlier connection");
  });

  test("does not attach when two devices share the name", async () => {
    const { session, sockets } = setup({
      targets: [
        { ...TARGET, id: "1", logicalDeviceId: "device-a" },
        { ...TARGET, id: "2", logicalDeviceId: "device-b" },
      ],
    });
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    expect(sockets).toHaveLength(0);
    expect(client.last("status")?.status).toEqual({
      state: "searching",
      message: expect.stringContaining("Rename one of them"),
    });
  });

  test("does not ask to rename the device when its apps report no device", async () => {
    const { session, sockets } = setup({
      targets: [
        { ...TARGET, id: "1", logicalDeviceId: undefined },
        { ...TARGET, id: "2", logicalDeviceId: undefined },
      ],
    });
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    expect(sockets).toHaveLength(0);
    expect(client.last("status")?.status).toEqual({
      state: "searching",
      message: expect.stringContaining("Close the other apps"),
    });
  });

  test("answers a body request to the asking dashboard only", async () => {
    const { session, sockets } = setup();
    const asker = new FakeClient();
    const other = new FakeClient();
    session.subscribe(asker);
    session.subscribe(other);
    await settle();
    const cdp = sockets[0]!;

    cdp.event("Network.requestWillBeSent", { requestId: "r1", request: { url: "https://x" } });
    asker.emit("message", JSON.stringify({ type: "get-response-body", id: "1.r1" }));
    await settle();
    const call = cdp.sent.find((m) => m.method === "Network.getResponseBody");
    expect(call.params).toEqual({ requestId: "r1" });
    cdp.reply(call.id, { body: '{"ok":true}', base64Encoded: false });
    await settle();

    expect(asker.last("response-body")).toEqual({
      type: "response-body",
      id: "1.r1",
      body: { body: '{"ok":true}', base64Encoded: false },
    });
    expect(other.last("response-body")).toBeUndefined();
  });

  test("clear empties the list for every dashboard", async () => {
    const { session, sockets } = setup();
    const a = new FakeClient();
    const b = new FakeClient();
    session.subscribe(a);
    session.subscribe(b);
    await settle();
    sockets[0]!.event("Network.requestWillBeSent", {
      requestId: "r",
      request: { url: "https://x" },
    });
    a.emit("message", JSON.stringify({ type: "clear" }));

    expect(b.last("cleared")).toEqual({ type: "cleared" });
    const late = new FakeClient();
    session.subscribe(late);
    expect(late.last("snapshot")).toEqual({ type: "snapshot", requests: [] });
  });

  test(`keeps at most ${NETWORK_MAX_REQUESTS} requests, dropping the oldest`, async () => {
    const { session, sockets } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    for (let i = 0; i <= NETWORK_MAX_REQUESTS; i++) {
      sockets[0]!.event("Network.requestWillBeSent", {
        requestId: `r${i}`,
        request: { url: `https://x/${i}` },
      });
    }
    const late = new FakeClient();
    session.subscribe(late);
    const snapshot = late.last("snapshot")!.requests;
    expect(snapshot).toHaveLength(NETWORK_MAX_REQUESTS);
    expect(snapshot[0]!.id).toBe("1.r1");
    expect(client.last("request")).toMatchObject({ evicted: ["1.r0"] });
    const withEvictions = client.messages.filter((m) => m.type === "request" && m.evicted);
    expect(withEvictions).toHaveLength(1);
  });

  test("searches again when the app disconnects, and reattaches when it returns", async () => {
    const { session, sockets, setTargets, runPoll } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();

    sockets[0]!.close();
    expect(client.last("status")?.status.state).toBe("searching");

    setTargets([]);
    await runPoll();
    expect(client.last("status")?.status.state).toBe("searching");

    setTargets([
      { ...TARGET, webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=abc&page=2" },
    ]);
    await runPoll();
    expect(client.last("status")?.status.state).toBe("attached");
    expect(sockets.at(-1)!.url).toContain("page=2");
  });

  test("reports Metro as unavailable when its target list cannot be read", async () => {
    const failing = new NetworkSession(DEVICE, "http://127.0.0.1:9", () => {}, {
      listTargets: async () => {
        throw new Error("ECONNREFUSED");
      },
      deviceNames: async () => ["iPhone Duo (iOS 27.1)"],
      connect: () => {
        throw new Error("never connects without a target");
      },
      now: Date.now,
      setTimeout: (() => 0) as unknown as NetworkSessionDeps["setTimeout"],
      clearTimeout: () => {},
    });
    const client = new FakeClient();
    failing.subscribe(client);
    await settle();
    expect(client.last("status")?.status.state).toBe("unavailable");
  });

  test("closes the inspector connection after the last dashboard has been gone a while", async () => {
    const { session, sockets, timers, idled } = setup();
    const client = new FakeClient();
    session.subscribe(client);
    await settle();
    client.close();
    const idle = timers.find((t) => t.delay === 30_000 && !t.cancelled)!;
    idle.callback();
    expect(sockets[0]!.closed).toBe(true);
    expect(idled()).toBe(true);
  });
});

describe("networkWebSocketHandler", () => {
  const URL_FOR_IOS = "http://127.0.0.1:4040/api/network/ws?platform=ios&id=U&name=a&version=b";

  test("explains a remote EXPO_DEVICE_HUB_METRO_URL without closing the socket", () => {
    const previous = process.env.EXPO_DEVICE_HUB_METRO_URL;
    process.env.EXPO_DEVICE_HUB_METRO_URL = "http://192.168.1.2:8081";
    try {
      const client = new FakeClient();
      networkWebSocketHandler(client, new Request(URL_FOR_IOS));
      expect(client.closedWith).toBeUndefined();
      expect(client.last("status")?.status).toEqual({
        state: "unavailable",
        message: expect.stringContaining("on this machine"),
      });
    } finally {
      if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_METRO_URL;
      else process.env.EXPO_DEVICE_HUB_METRO_URL = previous;
    }
  });

  test("closes the socket for a request without a device", () => {
    const client = new FakeClient();
    networkWebSocketHandler(client, new Request("http://127.0.0.1:4040/api/network/ws"));
    expect(client.closedWith).toBe(1008);
  });
});

describe("adaptWebSocket", () => {
  test("gives a browser-style socket the listener interface the session uses", () => {
    const target = new EventTarget() as EventTarget & { send(): void; close(): void };
    const seen: unknown[] = [];
    const socket = adaptWebSocket(target as unknown as WebSocket);
    socket.on("open", () => seen.push("open"));
    socket.on("message", (data: unknown) => seen.push(data));
    target.dispatchEvent(new Event("open"));
    target.dispatchEvent(new MessageEvent("message", { data: "{}" }));
    expect(seen).toEqual(["open", "{}"]);
  });
});

describe("parseNetworkDeviceRef", () => {
  test("reads the device from the socket URL", () => {
    expect(
      parseNetworkDeviceRef(
        "http://h/api/network/ws?platform=android&id=emulator-5554&name=Pixel&version=Android%2017",
      ),
    ).toEqual({ platform: "android", id: "emulator-5554", name: "Pixel", version: "Android 17" });
    expect(
      parseNetworkDeviceRef("http://h/api/network/ws?platform=tv&id=x&name=a&version=b"),
    ).toBeNull();
    expect(
      parseNetworkDeviceRef("http://h/api/network/ws?platform=ios&name=a&version=b"),
    ).toBeNull();
  });
});
