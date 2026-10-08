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
  const state = { mode: "hold" as ReadMode, aborted: 0, fontScale: 1 };
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
        return Response.json({
          url: `${url.origin}/ios/helper/${device}`,
          device,
          basePath: "/ios",
          proxyHelpers: true,
          execToken: "exec-token",
        });
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
          ui?: { device: string; option?: string };
        };
        if (message.token) {
          socket.send(JSON.stringify({ ready: true }));
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
                      : { id: message.id, status: mode === "empty" ? {} : { appearance: "dark" } },
                ),
              );
            },
          });
        }
      },
    },
  });
  stopServer = () => {
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
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  return {
    state,
    reads,
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
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready", 4000);
  expect(mounted.client().deviceSettings?.appearance).toBe("dark");
  expect(mounted.client().deviceSettings?.["text-size"]).toBe("medium");
});

test("Android: Appearance recovers after a partial read and stops retrying after success", async () => {
  const server = settingsServer();
  server.state.mode = "appearance-error";
  const mounted = await mountClient("android", server.baseUrl("android"));
  await waitFor(() => mounted.client().deviceSettingsStatus === "ready");
  expect(mounted.client().deviceSettings?.appearance).toBeUndefined();
  expect(mounted.client().deviceSettings?.network).toBe("on");

  server.state.mode = "ready";
  server.state.fontScale = 1.3;
  await waitFor(() => mounted.client().deviceSettings?.["text-size"] === "extra-large", 4000);
  expect(mounted.client().deviceSettings?.appearance).toBe("dark");
  expect(mounted.client().appearance).toBe("dark");
  const appearanceReads = () => server.reads.filter((read) => read.path === "/api/uimode").length;
  expect(appearanceReads()).toBe(2);

  server.state.fontScale = 1.15;
  await waitFor(() => mounted.client().deviceSettings?.["text-size"] === "large", 4000);
  expect(appearanceReads()).toBe(2);
  expect(mounted.client().deviceSettings?.appearance).toBe("dark");
  const firstReady = mounted.committed.indexOf("ready");
  expect(mounted.committed.slice(firstReady).every((status) => status === "ready")).toBe(true);
}, 9000);

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
    const paths = Object.keys(ANDROID_RESPONSES).filter((path) => path !== "/api/uimode");
    await waitFor(
      () => paths.every((path) => server.reads.slice(start).some((read) => read.path === path)),
      4000,
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
  expect(values.tracked).toEqual({ appearance: "dark" });
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
}, 16000);

test("Android: background polls update values without rerendering status-only subscribers and retain them on failure", async () => {
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
  await waitFor(() => currentSettings()?.["text-size"] === "extra-large", 4000);
  expect(status).toBe("ready");
  expect(renders).toBe(before);
  const initialReads = server.reads.length;
  server.state.mode = "error";
  await waitFor(() => server.reads.length > initialReads, 4000);
  await act(async () => {
    await Bun.sleep(30);
  });
  expect(status).toBe("ready");
  expect(currentSettings()?.["text-size"]).toBe("extra-large");
  expect(renders).toBe(before);
}, 10000);
