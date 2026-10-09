import { afterEach, expect, test } from "bun:test";
import { type ServerWebSocket } from "bun";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceClientProvider, useDeviceClientSelector } from "../DeviceClientProvider";
import {
  type DeviceClient,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceSettingsStatus,
} from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { useDeviceClient } from "../useDeviceClient";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

type ReadMode = "hold" | "ready" | "empty" | "error" | "malformed" | "partial" | "appearance-error";
type SocketData = { path: string; token: string | null };
type ReadRequest = {
  path: string;
  device: string;
  token: string | null;
  reply: (mode: Exclude<ReadMode, "hold">) => void;
};

const ANDROID_RESPONSES: Record<string, object> = {
  "/api/uimode": { ok: true, night: "yes" },
  "/api/network": { ok: true, network: { enabled: true } },
  "/api/font-scale": { ok: true, fontScale: { scale: 1 } },
  "/api/display-density": { ok: true, displayDensity: { scale: 1, widthDp: 411 } },
  "/api/reduce-motion": { ok: true, reduceMotion: { enabled: false } },
  "/api/font-weight": { ok: true, fontWeight: { enabled: false } },
  "/api/high-text-contrast": { ok: true, highTextContrast: { enabled: false } },
  "/api/software-keyboard": { ok: true, softwareKeyboard: { enabled: true } },
};

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
let stopServer: (() => void) | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  stopServer?.();
  stopServer = undefined;
  restoreGlobals();
});

// Exercise the real fetch/WebSocket paths. Only the browser globals needed to mount the hooks
// are supplied here; neither DeviceClient nor its request helpers are replaced.
function settingsServer() {
  const state = {
    mode: "hold" as ReadMode,
    discovery: "ready" as "ready" | "hold" | "error",
    aborted: 0,
    fontScale: 1,
    night: "yes",
    iosSettings: {} as DeviceSettings,
    authReady: true,
    authRequests: 0,
  };
  const controls = new Set<ServerWebSocket<SocketData>>();
  const pendingAuth = new Set<ServerWebSocket<SocketData>>();
  let replyDiscovery: (() => void) | undefined;
  const reads: ReadRequest[] = [];
  const pending: ReadRequest[] = [];
  const register = (read: ReadRequest) => {
    reads.push(read);
    if (state.mode === "hold") pending.push(read);
    else read.reply(state.mode);
  };
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const device = url.searchParams.get("device") ?? "DEVICE-1";
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      if (url.pathname.endsWith("/ws") || url.pathname === "/ios/exec-ws") {
        const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const socketToken = protocol?.startsWith("serve-sim.token.")
          ? protocol.slice("serve-sim.token.".length)
          : null;
        if (server.upgrade(request, { data: { path: url.pathname, token: socketToken } })) return;
        return new Response(null, { status: 400 });
      }
      if (url.pathname === "/ios/api") {
        const response = () => Response.json({
          url: `${url.origin}/ios/helper/${device}`,
          device,
          basePath: "/ios",
          proxyHelpers: true,
          execToken: "exec-token",
        });
        if (state.discovery === "error") return new Response(null, { status: 503 });
        if (state.discovery === "hold") {
          return new Promise<Response>((resolve) => {
            replyDiscovery = () => resolve(response());
          });
        }
        return response();
      }
      if (url.pathname === "/android/api") return Response.json({ screenRecording: null });
      const settingPath = url.pathname.replace(/^\/android/, "");
      if (ANDROID_RESPONSES[settingPath]) {
        request.signal.addEventListener("abort", () => state.aborted++, { once: true });
        return new Promise<Response>((resolve) =>
          register({
            path: settingPath,
            device,
            token,
            reply(mode) {
              if (
                mode === "error" ||
                (mode === "partial" && settingPath !== "/api/uimode") ||
                (mode === "appearance-error" && settingPath === "/api/uimode")
              ) {
                resolve(Response.json({ error: "Settings unavailable" }, { status: 503 }));
              } else {
                resolve(
                  Response.json(
                    mode === "malformed"
                      ? { ok: false, error: "Settings read failed" }
                      : mode === "empty"
                        ? { ok: true }
                        : settingPath === "/api/font-scale"
                          ? { ok: true, fontScale: { scale: state.fontScale } }
                          : settingPath === "/api/uimode"
                            ? { ok: true, night: state.night }
                            : ANDROID_RESPONSES[settingPath],
                  ),
                );
              }
            },
          }),
        );
      }
      return Response.json({}, { status: 404 });
    },
    websocket: {
      open(socket) {
        if (!socket.data.path.includes("/helper/")) return;
        const config = new TextEncoder().encode(JSON.stringify({ width: 390, height: 844 }));
        socket.send(new Uint8Array([0x82, ...config]));
      },
      message(socket: ServerWebSocket<SocketData>, data) {
        if (socket.data.path !== "/ios/exec-ws") return;
        const message = JSON.parse(String(data)) as {
          token?: string;
          id?: number;
          sub?: number;
          ui?: { device: string; option?: string };
        };
        if (message.token) {
          state.authRequests++;
          if (state.authReady) socket.send(JSON.stringify({ ready: true }));
          else pendingAuth.add(socket);
        } else if (message.sub != null) {
          controls.add(socket);
        } else if (message.ui && message.id != null) {
          if (message.ui.option) {
            socket.send(JSON.stringify({ id: message.id, ok: true }));
            return;
          }
          register({
            path: "/ios/exec-ws",
            device: message.ui.device,
            token: socket.data.token,
            reply(mode) {
              socket.send(
                JSON.stringify(
                  mode === "error"
                    ? { id: message.id, error: "Settings unavailable" }
                    : mode === "malformed"
                      ? { id: message.id, ok: true }
                      : {
                          id: message.id,
                          status: mode === "empty" ? {} : {
                            appearance: state.night === "yes" ? "dark" : "light",
                            ...state.iosSettings,
                          },
                        },
                ),
              );
            },
          });
        }
      },
      close(socket) {
        controls.delete(socket);
        pendingAuth.delete(socket);
      },
    },
  });
  stopServer = () => {
    replyDiscovery?.();
    for (const read of pending.splice(0)) read.reply("error");
    server.stop(true);
  };
  const page = server.url;
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: page.href, origin: page.origin, protocol: page.protocol, host: page.host },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const pageDocument = Object.assign(new EventTarget(), { hidden: false });
  stubGlobal("document", pageDocument);
  return {
    state,
    reads,
    controls,
    setHidden(hidden: boolean) {
      pageDocument.hidden = hidden;
      pageDocument.dispatchEvent(new Event("visibilitychange"));
    },
    authenticate() {
      state.authReady = true;
      for (const socket of pendingAuth) socket.send(JSON.stringify({ ready: true }));
      pendingAuth.clear();
    },
    baseUrl: (platform: DevicePlatform) => `${page.origin}/${platform}`,
    hasAllReads(platform: DevicePlatform, device = "DEVICE-1", token?: string) {
      const matching = reads.filter(
        (read) => read.device === device && (token == null || read.token === token),
      );
      return (
        new Set(matching.map((read) => read.path)).size >=
        (platform === "android" ? Object.keys(ANDROID_RESPONSES).length : 1)
      );
    },
    reply(device: string, mode: Exclude<ReadMode, "hold">, token?: string) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const read = pending[i]!;
        if (read.device !== device || (token != null && read.token !== token)) continue;
        pending.splice(i, 1);
        read.reply(mode);
      }
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error("Condition did not settle");
    await act(async () => {
      await Bun.sleep(10);
    });
  }
}

type ClientProps = { device?: string; enabled?: boolean; token?: string };
async function mountClient(platform: DevicePlatform, baseUrl: string, props: ClientProps = {}) {
  const useClient = platform === "ios" ? useIosDeviceClient : useAndroidDeviceClient;
  let client!: DeviceClient;
  const committed: DeviceSettingsStatus[] = [];
  function Harness({ device = "DEVICE-1", enabled = true, token }: ClientProps) {
    client = useClient({ baseUrl, device, enabled, token, streamMode: "mjpeg" });
    useLayoutEffect(() => {
      committed.push(client.deviceSettingsStatus);
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
  return {
    client: () => client,
    committed,
    update: (props: ClientProps) => act(async () => renderer!.update(<Harness {...props} />)),
  };
}

for (const platform of ["ios", "android"] as const) {
  test(`${platform}: idle while disabled, loading until read completes, ready without an app`, async () => {
    const server = settingsServer();
    const mounted = await mountClient(platform, server.baseUrl(platform), { enabled: false });
    expect(mounted.client().deviceSettingsStatus).toBe("idle");
    expect(server.reads).toHaveLength(0);
    await mounted.update({ enabled: true });
    await waitFor(() => server.hasAllReads(platform));
    expect(mounted.client().deviceSettingsStatus).toBe("loading");
    expect(mounted.client().deviceSettings).toBeNull();
    await act(async () => server.reply("DEVICE-1", "ready"));
    await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
    expect(mounted.client().deviceSettings?.appearance).toBe("dark");
    expect(mounted.client().foregroundApp).toBeNull();
  });

  test(`${platform}: a valid empty response settles instead of spinning forever`, async () => {
    const server = settingsServer();
    server.state.mode = "empty";
    const mounted = await mountClient(platform, server.baseUrl(platform));
    await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
    expect(mounted.client().deviceSettings).toEqual({});
  });

  for (const mode of ["error", "malformed"] as const) {
    test(`${platform}: ${mode} replies are errors, not successful empty reads`, async () => {
      const server = settingsServer();
      server.state.mode = mode;
      const mounted = await mountClient(platform, server.baseUrl(platform));
      await waitFor(() => ["ready", "error"].includes(mounted.client().deviceSettingsStatus));
      expect(mounted.client().deviceSettingsStatus).toBe("error");
      expect(mounted.client().deviceSettings).toBeNull();
    });
  }

  test(`${platform}: a stalled read reaches error at the request deadline`, async () => {
    const server = settingsServer();
    const mounted = await mountClient(platform, server.baseUrl(platform));
    await waitFor(() => server.reads.length > 0);
    expect(mounted.client().deviceSettingsStatus).toBe("loading");
    const started = performance.now();
    await waitFor(() => mounted.client().deviceSettingsStatus === "error", 6500);
    expect(performance.now() - started).toBeGreaterThan(4500);
    expect(mounted.client().deviceSettings).toBeNull();
    if (platform === "android") await waitFor(() => server.state.aborted > 0);
  }, 9000);

  test(`${platform}: old device replies cannot settle the newly selected device`, async () => {
    const server = settingsServer();
    const mounted = await mountClient(platform, server.baseUrl(platform));
    await waitFor(() => server.hasAllReads(platform));
    await mounted.update({ device: "DEVICE-2" });
    await waitFor(() => server.hasAllReads(platform, "DEVICE-2"));
    await act(async () => server.reply("DEVICE-1", "error"));
    expect(mounted.client().deviceSettingsStatus).toBe("loading");
    await act(async () => server.reply("DEVICE-2", "ready"));
    await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
    expect(mounted.client().deviceSettings?.appearance).toBe("dark");
  });

  test(`${platform}: changing credentials cannot carry ready into the new read`, async () => {
    const server = settingsServer();
    server.state.mode = "ready";
    const mounted = await mountClient(platform, server.baseUrl(platform), { token: "token-a" });
    await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
    server.state.mode = "hold";
    mounted.committed.length = 0;
    await mounted.update({ token: "token-b" });
    expect(mounted.committed[0]).not.toBe("ready");
    await waitFor(() => server.hasAllReads(platform, "DEVICE-1", "token-b"));
    expect(mounted.client().deviceSettingsStatus).toBe("loading");
    await act(async () => server.reply("DEVICE-1", "ready", "token-b"));
    await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  });
}

test("Android: supported controls remain usable when other endpoints fail", async () => {
  const server = settingsServer();
  server.state.mode = "partial";
  const mounted = await mountClient("android", server.baseUrl("android"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(mounted.client().deviceSettings).toEqual({ appearance: "dark" });
});

test("Android: a later poll recovers all initial values after a failed first read", async () => {
  const server = settingsServer();
  server.state.mode = "error";
  const mounted = await mountClient("android", server.baseUrl("android"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "error");
  server.state.mode = "ready";
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready", 6500);
  expect(mounted.client().deviceSettings?.appearance).toBe("dark");
  expect(mounted.client().deviceSettings?.["text-size"]).toBe("medium");
}, 8000);

test("Android: Appearance recovers after a partial read and keeps tracking external changes", async () => {
  const server = settingsServer();
  server.state.mode = "appearance-error";
  const mounted = await mountClient("android", server.baseUrl("android"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(mounted.client().deviceSettings?.appearance).toBeUndefined();
  expect(mounted.client().deviceSettings?.network).toBe("on");

  server.state.mode = "ready";
  server.state.fontScale = 1.3;
  await waitFor(() => mounted.client().deviceSettings?.["text-size"] === "extra-large", 6500);
  expect(mounted.client().deviceSettings?.appearance).toBe("dark");
  expect(mounted.client().appearance).toBe("dark");
  const appearanceReads = () => server.reads.filter((read) => read.path === "/api/uimode").length;
  expect(appearanceReads()).toBe(2);

  server.state.fontScale = 1.15;
  server.state.night = "no";
  await waitFor(() => mounted.client().deviceSettings?.["text-size"] === "large", 6500);
  expect(appearanceReads()).toBe(3);
  expect(mounted.client().deviceSettings?.appearance).toBe("light");
  expect(mounted.client().appearance).toBe("light");
  const firstReady = mounted.committed.indexOf("ready");
  expect(mounted.committed.slice(firstReady).every((status) => status === "ready")).toBe(true);
}, 13000);

test("Android: unchanged polls preserve settings references for tracked and selector subscribers", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  const values = {
    tracked: null as DeviceSettings | null,
    selected: null as DeviceSettings | null,
  };
  const renders = { tracked: 0, selected: 0 };
  function Tracked() {
    values.tracked = useDeviceClient().deviceSettings;
    renders.tracked++;
    return null;
  }
  function Selected() {
    values.selected = useDeviceClientSelector((client) => client.deviceSettings);
    renders.selected++;
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider
        platform="android"
        options={{ baseUrl: server.baseUrl("android"), device: "DEVICE-1", streamMode: "mjpeg" }}
      >
        <Tracked />
        <Selected />
      </DeviceClientProvider>,
    );
  });
  await waitFor(() => values.tracked?.["text-size"] === "medium");
  const initialSettings = values.tracked;
  const initialRenders = { ...renders };
  async function nextPoll(mode: Exclude<ReadMode, "hold">) {
    server.state.mode = "hold";
    const start = server.reads.length;
    const paths = Object.keys(ANDROID_RESPONSES);
    await waitFor(
      () => paths.every((path) => server.reads.slice(start).some((read) => read.path === path)),
      6500,
    );
    await act(async () => {
      server.reply("DEVICE-1", mode);
      await Bun.sleep(30);
    });
  }

  await nextPoll("ready");
  expect(values.tracked).toBe(initialSettings);
  expect(values.selected).toBe(initialSettings);
  expect(renders).toEqual(initialRenders);

  server.state.fontScale = 1.3;
  await nextPoll("ready");
  await waitFor(() => values.tracked?.["text-size"] === "extra-large");
  expect(values.tracked).not.toBe(initialSettings);
  expect(values.selected).toBe(values.tracked);
  expect(renders).toEqual({
    tracked: initialRenders.tracked + 1,
    selected: initialRenders.selected + 1,
  });

  await nextPoll("empty");
  await waitFor(() => values.tracked?.["text-size"] === undefined);
  expect(values.tracked).toEqual({});
  expect(values.selected).toBe(values.tracked);
  expect(renders).toEqual({
    tracked: initialRenders.tracked + 2,
    selected: initialRenders.selected + 2,
  });

  const afterRemoval = values.tracked;
  await nextPoll("empty");
  expect(values.tracked).toBe(afterRemoval);
  expect(values.selected).toBe(afterRemoval);
  expect(renders).toEqual({
    tracked: initialRenders.tracked + 2,
    selected: initialRenders.selected + 2,
  });
}, 25000);

test("Android: availability changes only on failure and recovery, retaining cached settings", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  let status!: DeviceSettingsStatus;
  let settings: DeviceSettings | null = null;
  const currentSettings = () => settings;
  let renders = 0;
  function Status() {
    status = useDeviceClient().deviceSettingsStatus;
    renders++;
    return null;
  }
  function Values() {
    settings = useDeviceClient().deviceSettings;
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider
        platform="android"
        options={{ baseUrl: server.baseUrl("android"), device: "DEVICE-1", streamMode: "mjpeg" }}
      >
        <Status />
        <Values />
      </DeviceClientProvider>,
    );
  });
  await waitFor(() => status === "ready");
  const before = renders;
  server.state.fontScale = 1.3;
  await waitFor(() => currentSettings()?.["text-size"] === "extra-large", 6500);
  expect(status).toBe("ready");
  expect(renders).toBe(before);
  const initialReads = server.reads.length;
  server.state.mode = "error";
  await waitFor(() => server.reads.length > initialReads, 6500);
  await act(async () => {
    await Bun.sleep(30);
  });
  expect(status).toBe("error");
  expect(currentSettings()?.["text-size"]).toBe("extra-large");
  expect(renders).toBe(before + 1);
  const cached = currentSettings();
  const failedReads = server.reads.length;
  await waitFor(() => server.reads.length > failedReads, 6500);
  await act(async () => { await Bun.sleep(30); });
  expect(renders).toBe(before + 1);
  server.state.mode = "ready";
  await waitFor(() => status === "ready", 6500);
  expect(currentSettings()).toBe(cached);
  expect(renders).toBe(before + 2);
}, 25000);

test("iOS: settings report loading during discovery and recover after discovery fails", async () => {
  const server = settingsServer();
  server.state.discovery = "hold";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  expect(mounted.client().capabilities.deviceSettings).toBe(false);
  expect(mounted.client().deviceSettingsStatus).toBe("loading");
  await waitFor(() => mounted.client().deviceSettingsStatus === "error", 4000);
  server.state.discovery = "ready";
  server.state.mode = "ready";
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready", 4000);
}, 9000);

test("iOS: an initial settings failure retries without returning to loading", async () => {
  const server = settingsServer();
  server.state.mode = "error";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "error");
  const firstError = mounted.committed.length;
  server.state.mode = "ready";
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready", 4000);
  expect(mounted.committed.slice(firstError)).not.toContain("loading");
});

test("iOS: control reconnects retain settings references and render availability only on transitions", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  let status!: DeviceSettingsStatus;
  let settings: DeviceSettings | null = null;
  let selected: DeviceSettings | null = null;
  const currentSettings = () => settings;
  const selectedSettings = () => selected;
  const renders = { status: 0, values: 0, selected: 0 };
  function Status() {
    status = useDeviceClient().deviceSettingsStatus;
    renders.status++;
    return null;
  }
  function Values() {
    settings = useDeviceClient().deviceSettings;
    renders.values++;
    return null;
  }
  function Selected() {
    selected = useDeviceClientSelector((client) => client.deviceSettings);
    renders.selected++;
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider platform="ios" options={{ baseUrl: server.baseUrl("ios"), streamMode: "mjpeg" }}>
        <Status /><Values /><Selected />
      </DeviceClientProvider>,
    );
  });
  await waitFor(() => status === "ready" && server.controls.size > 0);
  const cached = currentSettings();
  const before = { ...renders };
  server.state.mode = "error";
  await act(async () => { for (const socket of server.controls) socket.close(); });
  await waitFor(() => status === "error");
  await waitFor(() => server.reads.length > 1, 4000);
  expect(currentSettings()).toBe(cached);
  expect(selectedSettings()).toBe(cached);
  expect(renders).toEqual({ ...before, status: before.status + 1 });
  server.state.mode = "ready";
  await waitFor(() => status === "ready", 4000);
  expect(currentSettings()).toBe(cached);
  expect(selectedSettings()).toBe(cached);
  expect(renders).toEqual({ ...before, status: before.status + 2 });
}, 9000);

for (const replyTiming of ["before reconnect", "after reconnect", "after repeated reconnects"] as const) {
  test(`iOS: an interrupted active read is discarded ${replyTiming} and followed by a fresh read`, async () => {
    const server = settingsServer();
    const mounted = await mountClient("ios", server.baseUrl("ios"));
    await waitFor(() => server.reads.length === 1 && server.controls.size > 0);
    await act(async () => { for (const socket of server.controls) socket.close(); });
    await waitFor(() => mounted.client().deviceSettingsStatus === "error");
    if (replyTiming !== "before reconnect") {
      await waitFor(() => server.controls.size > 0, 4000);
    }
    if (replyTiming === "after repeated reconnects") {
      await act(async () => { for (const socket of server.controls) socket.close(); });
      await waitFor(() => server.controls.size === 0);
      await waitFor(() => server.controls.size > 0, 4000);
    }

    await act(async () => server.reply("DEVICE-1", "ready"));
    expect(mounted.client().deviceSettingsStatus).toBe("error");
    expect(mounted.client().deviceSettings).toBeNull();
    expect(mounted.client().appearance).toBeNull();
    await waitFor(() => server.reads.length === 2, 4000);
    server.state.night = "no";
    await act(async () => server.reply("DEVICE-1", "ready"));
    await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
    expect(mounted.client().deviceSettings?.appearance).toBe("light");
    expect(mounted.client().appearance).toBe("light");
    expect(server.reads).toHaveLength(2);
  }, 9000);
}

test.each(["ios", "android"] as const)("%s: external settings changes update subscribers, while unchanged polls stay quiet", async (platform) => {
  const server = settingsServer();
  server.state.mode = "ready";
  server.state.iosSettings = { "reduce-motion": "off" };
  let status!: DeviceSettingsStatus;
  let settings: DeviceSettings | null = null;
  let selected: DeviceSettings | null = null;
  const currentSettings = () => settings;
  const selectedSettings = () => selected;
  const renders = { status: 0, values: 0, selected: 0 };
  function Status() {
    status = useDeviceClient().deviceSettingsStatus;
    renders.status++;
    return null;
  }
  function Values() {
    settings = useDeviceClient().deviceSettings;
    renders.values++;
    return null;
  }
  function Selected() {
    selected = useDeviceClientSelector((client) => client.deviceSettings);
    renders.selected++;
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider platform={platform} options={{ baseUrl: server.baseUrl(platform), streamMode: "mjpeg" }}>
        <Status /><Values /><Selected />
      </DeviceClientProvider>,
    );
  });
  await waitFor(() => status === "ready");
  const before = { ...renders };
  server.state.night = "no";
  server.state.iosSettings["reduce-motion"] = "on";
  server.state.fontScale = 1.3;
  await waitFor(() => currentSettings()?.appearance === "light", 6500);
  expect(currentSettings()?.[platform === "ios" ? "reduce-motion" : "text-size"]).toBe(platform === "ios" ? "on" : "extra-large");
  expect(selectedSettings()).toBe(currentSettings());
  expect(renders).toEqual({ status: before.status, values: before.values + 1, selected: before.selected + 1 });
  const cached = currentSettings();
  const afterChange = { ...renders };
  const reads = server.reads.length;
  await waitFor(() => server.reads.length > reads, 6500);
  await act(async () => { await Bun.sleep(30); });
  expect(currentSettings()).toBe(cached);
  expect(selectedSettings()).toBe(cached);
  expect(renders).toEqual(afterChange);
}, 22000);

test.each(["ios", "android"] as const)("%s: hidden tabs pause settings polls, resume immediately, and remove polling on disable", async (platform) => {
  const server = settingsServer();
  const readCount = () => server.reads.filter((read) => read.path === (platform === "ios" ? "/ios/exec-ws" : "/api/uimode")).length;
  server.state.mode = "ready";
  server.setHidden(true);
  const mounted = await mountClient(platform, server.baseUrl(platform));
  await waitFor(() => mounted.client().capabilities.deviceSettings);
  await act(async () => { await Bun.sleep(50); });
  expect(readCount()).toBe(0);
  await act(async () => server.setHidden(false));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  const reads = readCount();
  await act(async () => server.setHidden(true));
  server.state.night = "no";
  await act(async () => { await Bun.sleep(5500); });
  expect(readCount()).toBe(reads);
  await act(async () => server.setHidden(false));
  await waitFor(() => mounted.client().deviceSettings?.appearance === "light");
  await mounted.update({ enabled: false });
  const disabledReads = readCount();
  await act(async () => { server.setHidden(true); server.setHidden(false); await Bun.sleep(5500); });
  expect(mounted.client().deviceSettingsStatus).toBe("idle");
  expect(readCount()).toBe(disabledReads);
}, 22000);

test.each(["ios", "android"] as const)("%s: settings polls wait five seconds after an active read settles", async (platform) => {
  const server = settingsServer();
  const readCount = () => server.reads.filter((read) => read.path === (platform === "ios" ? "/ios/exec-ws" : "/api/uimode")).length;
  const mounted = await mountClient(platform, server.baseUrl(platform));
  await waitFor(() => readCount() === 1);
  await act(async () => { await Bun.sleep(3000); });
  expect(readCount()).toBe(1);
  server.state.mode = "ready";
  await act(async () => server.reply("DEVICE-1", "ready"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  await act(async () => { await Bun.sleep(4200); });
  expect(readCount()).toBe(1);
  await waitFor(() => readCount() === 2, 1500);
}, 15000);

test("Android: visibility resumes coalesce behind an active read and discard its stale reply", async () => {
  const server = settingsServer();
  const mounted = await mountClient("android", server.baseUrl("android"));
  await waitFor(() => server.hasAllReads("android"));
  const readCount = () => server.reads.filter((read) => read.path === "/api/uimode").length;
  await act(async () => {
    for (let i = 0; i < 2; i++) { server.setHidden(true); server.setHidden(false); }
  });
  expect(readCount()).toBe(1);
  await act(async () => server.reply("DEVICE-1", "ready"));
  await waitFor(() => readCount() === 2);
  expect(mounted.client().deviceSettingsStatus).toBe("loading");
  expect(mounted.client().deviceSettings).toBeNull();
  server.state.night = "no";
  await act(async () => server.reply("DEVICE-1", "ready"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(mounted.client().deviceSettings?.appearance).toBe("light");
  expect(readCount()).toBe(2);
});

test("iOS: a settings poll cannot overwrite a newer completed sidebar write", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  server.state.mode = "hold";
  await waitFor(() => server.reads.length === 2, 6500);
  await act(async () => mounted.client().setDeviceSetting("appearance", "light"));
  await waitFor(() => !mounted.client().deviceSettingsPending.has("appearance"));
  await act(async () => server.reply("DEVICE-1", "ready"));
  expect(mounted.client().deviceSettings?.appearance).toBe("light");
  expect(mounted.client().appearance).toBe("light");
  expect(mounted.client().deviceSettingsStatus).toBe("ready");
}, 12000);

test("iOS: failed periodic reads retain cached values and recover without loading flicker", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  const cached = mounted.client().deviceSettings;
  const before = mounted.committed.length;
  server.state.mode = "error";
  await waitFor(() => mounted.client().deviceSettingsStatus === "error", 6500);
  expect(mounted.client().deviceSettings).toBe(cached);
  server.state.mode = "ready";
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready", 4000);
  expect(mounted.client().deviceSettings).toBe(cached);
  expect(mounted.committed.slice(before)).not.toContain("loading");
}, 15000);

test("iOS: repeated settings failures back off and visibility restores a prompt refresh", async () => {
  const server = settingsServer();
  server.state.mode = "error";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "error");
  await waitFor(() => server.reads.length >= 2, 4000);
  await act(async () => { await Bun.sleep(2200); });
  expect(server.reads).toHaveLength(2);
  server.state.mode = "ready";
  await act(async () => { server.setHidden(true); server.setHidden(false); });
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(server.reads).toHaveLength(3);
}, 9000);

test("iOS: settings polls and visibility refreshes pause until the control socket authenticates again", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready" && server.controls.size > 0);
  server.state.authReady = false;
  await act(async () => { for (const socket of server.controls) socket.close(); });
  await waitFor(() => mounted.client().deviceSettingsStatus === "error");
  const initialAuth = server.state.authRequests;
  await waitFor(() => server.state.authRequests > initialAuth, 4000);
  const firstReconnectAuth = server.state.authRequests;
  await act(async () => mounted.client().attachLogs());
  await waitFor(() => server.state.authRequests > firstReconnectAuth);
  const reconnectAuth = server.state.authRequests;
  await act(async () => { server.setHidden(true); server.setHidden(false); await Bun.sleep(5500); });
  expect(server.state.authRequests).toBe(reconnectAuth);
  expect(server.reads).toHaveLength(1);
  server.state.night = "no";
  await act(async () => server.authenticate());
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(mounted.client().deviceSettings?.appearance).toBe("light");
}, 15000);

test("iOS: healthy log subscription changes pause polls until replacement authentication", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready" && server.controls.size > 0);
  const cached = mounted.client().deviceSettings;
  for (const changeLogs of [mounted.client().attachLogs, mounted.client().detachLogs]) {
    server.state.authReady = false;
    const initialAuth = server.state.authRequests;
    await act(async () => changeLogs());
    await waitFor(() => server.state.authRequests > initialAuth);
    const replacementAuth = server.state.authRequests;
    const reads = server.reads.length;
    await act(async () => { server.setHidden(true); server.setHidden(false); await Bun.sleep(5500); });
    expect(server.state.authRequests).toBe(replacementAuth);
    expect(server.reads).toHaveLength(reads);
    expect(mounted.client().deviceSettings).toBe(cached);
    expect(mounted.client().deviceSettingsStatus).toBe("ready");
    await act(async () => server.authenticate());
    await waitFor(() => server.reads.length === reads + 1);
    expect(mounted.client().deviceSettings).toBe(cached);
    expect(mounted.client().deviceSettingsStatus).toBe("ready");
  }
}, 25000);

test("iOS: replacement authentication refreshes immediately during settings retry backoff", async () => {
  const server = settingsServer();
  server.state.mode = "error";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "error" && server.controls.size > 0);
  await waitFor(() => server.reads.length === 3, 6500);
  server.state.authReady = false;
  const initialAuth = server.state.authRequests;
  await act(async () => mounted.client().attachLogs());
  await waitFor(() => server.state.authRequests > initialAuth);
  server.state.mode = "ready";
  await act(async () => server.authenticate());
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(server.reads).toHaveLength(4);
}, 10000);

test("iOS: healthy control replacement discards an active settings reply before authentication", async () => {
  const server = settingsServer();
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => server.reads.length === 1 && server.controls.size > 0);
  server.state.authReady = false;
  const initialAuth = server.state.authRequests;
  await act(async () => mounted.client().attachLogs());
  await waitFor(() => server.state.authRequests > initialAuth);
  await act(async () => server.reply("DEVICE-1", "ready"));
  expect(mounted.client().deviceSettingsStatus).toBe("loading");
  expect(mounted.client().deviceSettings).toBeNull();
  expect(mounted.client().appearance).toBeNull();
  server.state.night = "no";
  server.state.mode = "ready";
  await act(async () => server.authenticate());
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(mounted.client().deviceSettings?.appearance).toBe("light");
  expect(server.reads).toHaveLength(2);
});

test("iOS: a reconnect read cannot overwrite a newer completed setting write", async () => {
  const server = settingsServer();
  server.state.mode = "ready";
  const mounted = await mountClient("ios", server.baseUrl("ios"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready" && server.controls.size > 0);
  const initialReads = server.reads.length;
  server.state.mode = "hold";
  await act(async () => { for (const socket of server.controls) socket.close(); });
  await waitFor(() => server.reads.length > initialReads, 4000);
  await act(async () => mounted.client().setDeviceSetting("appearance", "light"));
  await waitFor(() => !mounted.client().deviceSettingsPending.has("appearance"));
  await act(async () => server.reply("DEVICE-1", "ready"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(mounted.client().deviceSettings?.appearance).toBe("light");
  expect(mounted.client().appearance).toBe("light");
});
