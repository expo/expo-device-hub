import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient } from "../types";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const PHONE = "00008101-0016603236F0801E";
const SIMULATOR = "C485D903-49A6-4A6D-A199-7893ACF635AE";

const PHONE_UNAVAILABLE = Object.fromEntries(
  [
    "clipboard",
    "apps",
    "permissions",
    "location",
    "logs",
    "deviceSettings",
    "appInjection",
    "devtools",
    "accessibility",
    "foregroundApp",
    "activity",
    "hinge",
    "rotate",
    "hardwareButtons",
    "lifecycle",
  ].map((feature) => [feature, `${feature} is not available on a physical device.`]),
);

type FakeSocket = {
  url: string;
  readyState: number;
  sent: unknown[];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
};

async function renderClient(
  device: string,
  unavailableFeatures?: Record<string, string>,
  firstResponse?: object,
  startFailure?: { status: number; error: string },
) {
  const sockets: FakeSocket[] = [];
  const starts: string[] = [];
  let response: object | undefined = firstResponse;
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: {
      href: "http://localhost:3200/",
      origin: "http://localhost:3200",
      protocol: "http:",
      host: "localhost:3200",
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal(
    "WebSocket",
    class {
      readyState = 0;
      sent: unknown[] = [];
      constructor(readonly url: string) {
        sockets.push(this as unknown as FakeSocket);
      }
      send(data: unknown) {
        this.sent.push(data);
      }
      close() {}
    },
  );
  stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const endpoint = new URL(String(url), "http://localhost:3200");
    if (endpoint.pathname === "/sim/grid/api/start") {
      starts.push(String(init?.body));
      if (startFailure)
        return Response.json(
          { ok: false, error: startFailure.error },
          { status: startFailure.status },
        );
      response = undefined;
      return Response.json({ ok: true });
    }
    if (endpoint.pathname === "/sim/api") {
      if (response) return Response.json(response);
      return Response.json({
        inputAdmission: true,
        inputPaste: true,
        inputCopy: true,
        device,
        execToken: "exec-token",
        url: `http://localhost:3200/sim/helper/${device}`,
        streamUrl: `http://localhost:3200/sim/helper/${device}/stream.mjpeg`,
        wsUrl: `ws://localhost:3200/sim/helper/${device}/ws`,
        basePath: "/sim",
        logsEndpoint: `/sim/logs?device=${device}`,
        appStateEndpoint: `/sim/appstate?device=${device}`,
        metricsEndpoint: `/sim/metrics?device=${device}`,
        axEndpoint: `/sim/ax?device=${device}`,
        eventLogEventsEndpoint: `/sim/api/event-log/events?device=${device}`,
        ...(unavailableFeatures ? { unavailableFeatures } : {}),
      });
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  let startRequest = 0;
  function Harness() {
    client = useIosDeviceClient({ baseUrl: "/sim", device, streamMode: "mjpeg", startRequest });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const pushConfig = async (value: object) => {
    const control = sockets.find((socket) => socket.url.endsWith("/exec-ws"))!;
    if (control.readyState !== 1) {
      control.readyState = 1;
      await act(async () => {
        control.onopen?.();
        control.onmessage?.({ data: JSON.stringify({ ready: true }) });
      });
    }
    const subscription = control.sent
      .map((data) => JSON.parse(String(data)) as { sub?: number; path?: string })
      .find((message) => message.path?.includes("/api/events"))!;
    await act(async () =>
      control.onmessage?.({
        data: JSON.stringify({ sub: subscription.sub, data: `data: ${JSON.stringify(value)}\n\n` }),
      }),
    );
  };
  const selectAgain = async () => {
    startRequest++;
    await act(async () => renderer?.update(<Harness />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  return Object.assign(() => client, {
    pushConfig,
    selectAgain,
    starts,
    sockets: () => sockets,
    respondWith: (value: object | undefined) => {
      response = value;
    },
  });
}

test("a physical iPhone reports every simulator feature as unavailable", async () => {
  const client = await renderClient(PHONE, PHONE_UNAVAILABLE);

  expect(client().capabilities).toMatchObject({
    deviceSettings: false,
    activity: false,
    accessibility: false,
    location: false,
    clipboard: false,
    orientation: false,
    fold: false,
    logs: false,
    foregroundApp: false,
    permissions: false,
    camera: false,
  });
  expect(client().capabilities.events).toBe(true);
});

test("a physical iPhone gives serve-sim's reason for each capability it lacks", async () => {
  const client = await renderClient(PHONE, PHONE_UNAVAILABLE);

  expect(client().unavailableReasons).toEqual({
    deviceSettings: PHONE_UNAVAILABLE.deviceSettings,
    orientation: PHONE_UNAVAILABLE.rotate,
    fold: PHONE_UNAVAILABLE.hinge,
    logs: PHONE_UNAVAILABLE.logs,
    foregroundApp: PHONE_UNAVAILABLE.foregroundApp,
    location: PHONE_UNAVAILABLE.location,
    accessibility: PHONE_UNAVAILABLE.accessibility,
    activity: PHONE_UNAVAILABLE.activity,
    clipboard: PHONE_UNAVAILABLE.clipboard,
  });
});

test("a simulator keeps its features when the server reports none unavailable", async () => {
  const client = await renderClient(SIMULATOR, {});

  expect(client().capabilities).toMatchObject({
    deviceSettings: true,
    activity: true,
    accessibility: true,
    clipboard: { paste: true, copy: true },
    logs: true,
    foregroundApp: true,
  });
  expect(client().unavailableReasons).toEqual({});
});

test("an older server without the field leaves every feature in place", async () => {
  const client = await renderClient(SIMULATOR);

  expect(client().capabilities).toMatchObject({ logs: true, foregroundApp: true, activity: true });
});

test("a phone that goes away ends the session with the reason and does not restart it", async () => {
  const client = await renderClient(PHONE, PHONE_UNAVAILABLE);
  expect(client().status).not.toBe("error");

  await client.pushConfig({ device: PHONE, ended: { reason: "iPhone disconnected" } });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  expect(client().status).toBe("error");
  expect(client().error).toBe("iPhone disconnected");
  expect(client.starts).toEqual([]);
});

test("opening a phone whose last session ended starts a new one", async () => {
  const client = await renderClient(PHONE, PHONE_UNAVAILABLE, {
    device: PHONE,
    ended: { reason: "iPhone disconnected" },
  });

  expect(client.starts).toEqual([JSON.stringify({ udid: PHONE })]);
  expect(client().error).not.toBe("iPhone disconnected");
});

test("selecting an ended phone again starts it", async () => {
  const client = await renderClient(PHONE, PHONE_UNAVAILABLE);
  await client.pushConfig({ device: PHONE, ended: { reason: "iPhone disconnected" } });
  client.respondWith({ device: PHONE, ended: { reason: "iPhone disconnected" } });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(client.starts).toEqual([]);

  await client.selectAgain();

  expect(client.starts).toEqual([JSON.stringify({ udid: PHONE })]);
  expect(client().error).toBeNull();
  expect(client().status).not.toBe("error");
});

test("selecting a streaming phone again neither starts nor reconnects it", async () => {
  const client = await renderClient(PHONE, PHONE_UNAVAILABLE);
  const socketsBefore = client.sockets().length;

  await client.selectAgain();
  await client.selectAgain();

  expect(client.starts).toEqual([]);
  expect(client.sockets().length).toBe(socketsBefore);
  expect(client().error).toBeNull();
});

test("selecting a phone again after its start was refused asks once more", async () => {
  const client = await renderClient(
    PHONE,
    PHONE_UNAVAILABLE,
    {},
    { status: 409, error: "needs Xcode 27" },
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(client.starts).toHaveLength(1);

  await client.selectAgain();

  expect(client.starts).toHaveLength(2);
  expect(client().error).toBe("needs Xcode 27");
});

test("a phone that cannot stream shows why its start was refused", async () => {
  const client = await renderClient(
    PHONE,
    PHONE_UNAVAILABLE,
    {},
    { status: 409, error: "needs Xcode 27" },
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  expect(client.starts).toEqual([JSON.stringify({ udid: PHONE })]);
  expect(client().status).toBe("error");
  expect(client().error).toBe("needs Xcode 27");
});

test("a simulator whose start fails keeps waiting for its helper", async () => {
  const client = await renderClient(
    SIMULATOR,
    undefined,
    {},
    { status: 500, error: "boot failed" },
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  expect(client.starts).toEqual([JSON.stringify({ udid: SIMULATOR })]);
  expect(client().status).not.toBe("error");
  expect(client().error).toBeNull();
});

async function admitInput(client: Awaited<ReturnType<typeof renderClient>>) {
  const input = client.sockets().find((socket) => socket.url.includes("/helper/"))!;
  input.readyState = 1;
  await act(async () => {
    input.onopen?.();
    input.onmessage?.({ data: new Uint8Array([0x83]).buffer });
  });
  return input.sent.map((data) => new Uint8Array(data as ArrayBuffer)[0]);
}

test("a phone's input socket leaves the simulator keyboard setting alone", async () => {
  const client = await renderClient(PHONE, PHONE_UNAVAILABLE);

  expect(await admitInput(client)).not.toContain(0x0e);
  expect(client().hardwareKeyboardConnected).toBeNull();
});

test("a simulator's input socket disconnects the hardware keyboard on admission", async () => {
  const client = await renderClient(SIMULATOR, {});

  expect(await admitInput(client)).toContain(0x0e);
  expect(client().hardwareKeyboardConnected).toBe(false);
});
