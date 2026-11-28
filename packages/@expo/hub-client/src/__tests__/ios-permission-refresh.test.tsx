import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DeviceClientProvider, useDeviceClientSelector } from "../DeviceClientProvider";
import { type DeviceClient } from "../types";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

test("the iOS device hook refreshes on reconnect and drops a backgrounded permission target", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: "https://hub.test/" },
    addEventListener() {},
    removeEventListener() {},
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  const intervals = new Map<number, () => void>();
  let intervalId = 0;
  stubGlobal("setInterval", (tick: () => void) => {
    intervals.set(++intervalId, tick);
    return intervalId;
  });
  stubGlobal("clearInterval", (id: number) => intervals.delete(id));
  const actions: string[] = [];
  const sockets: Socket[] = [];
  class Socket {
    readonly readyState = 1;
    sent: any[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.action) actions.push(message.action);
      if (message.id !== undefined)
        queueMicrotask(() =>
          this.reply({
            id: message.id,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              message.action === "permissions.list"
                ? { permissions: [{ id: "camera", label: "Camera", state: "denied" }] }
                : {},
            ),
          }),
        );
    }
    reply(value: object) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    close() {}
  }
  stubGlobal("WebSocket", Socket);
  const appEvents: AppStateSource[] = [];
  class AppStateSource {
    onmessage?: (event: { data: string }) => void;
    readonly listeners = new Map<string, () => void>();
    constructor() {
      appEvents.push(this);
    }
    addEventListener(name: string, listener: () => void) {
      this.listeners.set(name, listener);
    }
    close() {}
  }
  stubGlobal("EventSource", AppStateSource);
  stubGlobal("fetch", async (url: string) =>
    new URL(url).pathname === "/ios/api"
      ? Response.json({
          url: "https://hub.test/ios/helper/DEVICE-A",
          device: "DEVICE-A",
          execToken: "test-token",
          appStateEndpoint: "/appstate",
          metricsEndpoint: "/metrics",
        })
      : Response.json({}, { status: 404 }),
  );
  let client!: DeviceClient;
  function Client() {
    client = useDeviceClientSelector((snapshot) => snapshot);
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider
        platform="ios"
        options={{ baseUrl: "https://hub.test/ios", streamMode: "mjpeg" }}
      >
        <Client />
      </DeviceClientProvider>,
    );
  });
  const channel = sockets.find((socket) => socket.url.endsWith("/exec-ws"))!;
  expect(channel).toBeDefined();
  await act(async () => channel.reply({ ready: true }));
  expect(appEvents).toHaveLength(1);
  await act(async () =>
    appEvents[0].onmessage?.({ data: JSON.stringify({ bundleId: "test.app", pid: 123 }) }),
  );
  expect(client.foregroundApp?.id).toBe("test.app");
  const metrics = channel.sent.find((message) => message.path === "/metrics");
  expect(metrics).toBeDefined();
  await act(async () =>
    channel.reply({
      sub: metrics.sub,
      data: `data: ${JSON.stringify({ t: Date.now(), bundleId: "test.app", cpuPct: 0, memBytes: 0, netInBytesPerSec: 0, netOutBytesPerSec: 0 })}\n\n`,
    }),
  );
  const permissionReads = () => actions.filter((action) => action === "permissions.list").length;
  const before = permissionReads();
  for (let i = 0; i < 3; i++)
    await act(async () => {
      for (const tick of [...intervals.values()]) tick();
    });
  expect(permissionReads()).toBe(before);
  await act(async () => {
    channel.onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
  const reconnected = sockets.filter((socket) => socket.url.endsWith("/exec-ws")).at(-1)!;
  expect(reconnected).not.toBe(channel);
  await act(async () => reconnected.reply({ ready: true }));
  expect(permissionReads()).toBe(before + 1);
  expect(client.permissions?.[0].state).toBe("denied");

  await act(async () => appEvents[0].listeners.get("foreground-clear")?.());
  expect(client.foregroundApp).toBeNull();
  expect(client.permissions).toBeNull();
  await act(async () => {
    client.setPermission("camera", "grant");
    client.resetPermissions();
    client.refreshPermissions();
  });
  expect(actions).not.toContain("permissions.set");
  expect(actions).not.toContain("permissions.resetAll");
  expect(permissionReads()).toBe(before + 1);
});
