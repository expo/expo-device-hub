import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceScreen } from "../DeviceScreen";
import { IOS_INPUT_UNAVAILABLE_MESSAGE } from "../ios-input-error";
import { type DeviceClient } from "../types";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
  jest.useRealTimers();
});

const CLIENT_LIMIT_REASON = "Simulator input unavailable; retry after other clients disconnect";

type FakeSocket = {
  url: string;
  readyState: number;
  sent: ArrayBuffer[];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
};

async function renderIosClient(
  inputAdmission: unknown = true,
  helper: { pid: number; absent?: boolean; discovery?: Promise<void> } = { pid: 1 },
  renderScreen = false,
  coarsePointer = true,
  strictMode = false,
) {
  const sockets: FakeSocket[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const addListener = (name: string, callback: () => void) => {
    const current = listeners.get(name) ?? new Set();
    current.add(callback);
    listeners.set(name, current);
  };
  const removeListener = (name: string, callback: () => void) =>
    listeners.get(name)?.delete(callback);
  const realTimeout = globalThis.setTimeout;
  stubGlobal("setTimeout", (callback: () => void, delay: number) =>
    realTimeout(
      callback,
      delay === 13_000 ? 20 : delay === 1500 ? 10 : delay === 1000 || delay === 5000 ? 20 : delay,
    ),
  );
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: {
      href: "http://localhost:3200/",
      origin: "http://localhost:3200",
      protocol: "http:",
      host: "localhost:3200",
    },
    addEventListener: addListener,
    removeEventListener: removeListener,
    setTimeout,
    clearTimeout,
    matchMedia: (query: string) => ({
      matches: coarsePointer && query === "(pointer: coarse)",
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  stubGlobal("document", {
    hidden: false,
    addEventListener: addListener,
    removeEventListener: removeListener,
  });
  stubGlobal(
    "WebSocket",
    class {
      readyState = 0;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      sent: ArrayBuffer[] = [];
      send(data: ArrayBuffer) {
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
  stubGlobal("fetch", async (url: string) => {
    const endpoint = new URL(String(url), "http://localhost:3200");
    if (endpoint.pathname === "/sim/api") {
      await helper.discovery;
      if (helper.absent) return Response.json(null);
      const device = endpoint.searchParams.get("device");
      return Response.json({
        inputAdmission: inputAdmission === false ? undefined : inputAdmission,
        device,
        pid: helper.pid,
        url: `http://localhost:3200/sim/helper/${device}`,
        streamUrl: `http://localhost:3200/sim/helper/${device}/stream.mjpeg`,
        wsUrl: `ws://localhost:3200/sim/helper/${device}/ws`,
      });
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness({
    device = "DEVICE-A",
    token = null,
    enabled = true,
  }: {
    device?: string;
    token?: string | null;
    enabled?: boolean;
  }) {
    client = useIosDeviceClient({ baseUrl: "/sim", device, token, enabled, streamMode: "mjpeg" });
    return renderScreen ? <DeviceScreen client={client} /> : null;
  }
  const surface = {
    focus() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }),
  };
  await act(async () => {
    renderer = create(
      strictMode ? (
        <StrictMode>
          <Harness />
        </StrictMode>
      ) : (
        <Harness />
      ),
      {
        createNodeMock: (node) => (node.type === "div" ? surface : null),
      },
    );
  });
  const helperSockets = () => sockets.filter((socket) => socket.url.includes("/helper/"));
  return {
    surface,
    client: () => client,
    helperSockets,
    dispatch: (name: string) => listeners.get(name)?.forEach((callback) => callback()),
    changeDevice: (device: string) => renderer!.update(<Harness device={device} />),
    changeOptions: (options: { device?: string; token?: string | null; enabled?: boolean }) =>
      renderer!.update(<Harness {...options} />),
  };
}

function configFrame(config: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(config));
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = 0x82;
  bytes.set(json, 1);
  return bytes.buffer;
}

test("a rejected input socket reports inputError until a later socket is admitted", async () => {
  const { client, helperSockets } = await renderIosClient();
  expect(helperSockets()).toHaveLength(1);
  expect(client().inputError).toBeNull();

  await act(async () => helperSockets()[0]!.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(client().inputError).toBeNull();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  // A plain drop during the retry keeps the rejection visible.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(helperSockets()).toHaveLength(2);
  await act(async () => helperSockets()[1]!.onclose?.({ code: 1006, reason: "" }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const socket = helperSockets()[2]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  expect(client().inputError).toBeNull();
});

test("serve-sim inputUnavailable in the screen config reports inputError", async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({
        width: 390,
        height: 844,
        orientation: "portrait",
        inputUnavailable: true,
      }),
    }),
  );
  expect(client().inputError).toBe(IOS_INPUT_UNAVAILABLE_MESSAGE);

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({
        width: 390,
        height: 844,
        orientation: "portrait",
        inputUnavailable: false,
      }),
    }),
  );
  expect(client().inputError).toBeNull();
});

test("malformed config frames cannot admit modern input or set keyboard state", async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  expect(client().hardwareKeyboardConnected).toBeNull();
  await act(async () => socket.onmessage?.({ data: configFrame({ width: "390", height: 844 }) }));
  expect(client().hardwareKeyboardConnected).toBeNull();
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  expect(client().hardwareKeyboardConnected).toBe(false);
});

for (const coarsePointer of [false, true]) {
  for (const inputAdmission of [true, false]) {
    test(`${coarsePointer ? "touch" : "desktop"} admission disconnects the hardware keyboard on ${inputAdmission ? "modern" : "legacy"} helpers and reconnect`, async () => {
      const { client, helperSockets } = await renderIosClient(
        inputAdmission,
        { pid: 1 },
        false,
        coarsePointer,
      );
      const admit = async (socket: FakeSocket) => {
        socket.readyState = 1;
        await act(async () => socket.onopen?.());
        if (inputAdmission) {
          expect(socket.sent).toHaveLength(0);
          await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
        }
        const frame = new Uint8Array(socket.sent[0]!);
        expect(frame[0]).toBe(0x0e);
        expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({ enabled: false });
        expect(client().hardwareKeyboardConnected).toBe(false);
      };
      const socket = helperSockets()[0]!;
      await admit(socket);
      await act(async () => socket.onclose?.({ code: 1006, reason: "" }));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      expect(helperSockets()).toHaveLength(2);
      await admit(helperSockets()[1]!);
    });
  }
}

test("legacy OPEN sends input while recovery waits out the refusal grace", async () => {
  const { client, helperSockets } = await renderIosClient(false);
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  expect(client().hardwareKeyboardConnected).toBe(false);
});

test("screen config cannot clear a refusal before modern admission", async () => {
  const { client, helperSockets } = await renderIosClient();
  await act(async () => helperSockets()[0]!.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const socket = helperSockets()[1]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  await act(async () =>
    socket.onmessage?.({ data: configFrame({ width: 390, height: 844, orientation: "portrait" }) }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  expect(client().hardwareKeyboardConnected).toBeNull();
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  expect(client().inputError).toBeNull();
  expect(client().hardwareKeyboardConnected).toBe(false);
});

test("an overload warning survives admission but expires without changing owners", async () => {
  jest.useFakeTimers();
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = "Simulator input queue full; send smaller batches or slow down";
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  expect(client().inputError).toBe(reason);
  await act(async () => {
    jest.advanceTimersByTime(12);
  });
  const retry = helperSockets()[1]!;
  retry.readyState = 1;
  await act(async () => retry.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  expect(client().inputError).toBe(reason);
  await act(async () => {
    jest.advanceTimersByTime(30);
  });
  expect(client().inputError).toBeNull();
});

test("an overload warning outlives a helper restart at the same URL", async () => {
  jest.useFakeTimers();
  const helper = { pid: 1 };
  const { client, helperSockets } = await renderIosClient(true, helper);
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = "Simulator input queue full; send smaller batches or slow down";
  helper.pid = 2;
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  await act(async () => {
    jest.advanceTimersByTime(12);
  });
  expect(helperSockets().length).toBeGreaterThan(2);
  expect(client().inputError).toBe(reason);
  await act(async () => {
    jest.advanceTimersByTime(30);
  });
  expect(client().inputError).toBeNull();
});

test("an overload warning outlives a helper that is briefly absent", async () => {
  jest.useFakeTimers();
  const helper = { pid: 1, absent: false };
  const { client, helperSockets } = await renderIosClient(true, helper);
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = "Simulator input queue full; send smaller batches or slow down";
  helper.absent = true;
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  await act(async () => {
    jest.advanceTimersByTime(12);
  });
  expect(client().status).toBe("connecting");
  expect(client().inputError).toBe(reason);
  await act(async () => {
    jest.advanceTimersByTime(30);
  });
  expect(client().inputError).toBeNull();
});

test("an overload warning stays with its device", async () => {
  const helper = { pid: 1, absent: false };
  const { client, helperSockets, changeDevice } = await renderIosClient(true, helper);
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = "Simulator input queue full; send smaller batches or slow down";
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  expect(client().inputError).toBe(reason);
  helper.absent = true;
  await act(async () => changeDevice("DEVICE-B"));
  expect(client().inputError).toBeNull();
});

function buttons(socket: FakeSocket) {
  return socket.sent
    .filter((data) => new Uint8Array(data)[0] === 0x04)
    .map((data) => JSON.parse(new TextDecoder().decode(new Uint8Array(data).subarray(1))).button);
}

async function admit(socket: FakeSocket) {
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  expect(buttons(socket)).toEqual([]);
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
}

test("fresh controls entered before discovery wait for input admission", async () => {
  let release!: () => void;
  const helper = {
    pid: 1,
    discovery: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const { client, helperSockets } = await renderIosClient(true, helper);
  expect(helperSockets()).toHaveLength(0);
  await act(async () => client().pressButton("home"));
  await act(async () => release());
  const socket = helperSockets()[0]!;
  await admit(socket);
  expect(buttons(socket)).toEqual(["home"]);
});

for (const replaced of [false, true]) {
  test(`a discovery gap ${replaced ? "drops commands for a replaced helper" : "retains fresh commands for the same helper"}`, async () => {
    const helper = { pid: 1, absent: false };
    const { client, helperSockets } = await renderIosClient(true, helper);
    // Queue one command before admission, then remove the helper from discovery.
    await act(async () => client().pressButton("home"));
    helper.absent = true;
    await act(async () => helperSockets()[0]!.onclose?.({ code: 1006, reason: "" }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
    expect(client().status).toBe("connecting");
    await act(async () => client().pressButton("power"));
    helper.absent = false;
    if (replaced) helper.pid++;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const socket = helperSockets().at(-1)!;
    await admit(socket);
    expect(buttons(socket)).toEqual(replaced ? [] : ["home", "lock"]);
  });
}

for (const changed of ["device", "token", "disabled"] as const) {
  test(`early input is discarded when ${changed} changes`, async () => {
    let release!: () => void;
    const helper = {
      pid: 1,
      discovery: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { client, helperSockets, changeOptions } = await renderIosClient(true, helper);
    await act(async () => client().pressButton("home"));
    await act(async () =>
      changeOptions(
        changed === "device"
          ? { device: "DEVICE-B" }
          : changed === "token"
            ? { token: "new-token" }
            : { enabled: false },
      ),
    );
    if (changed === "disabled") await act(async () => changeOptions({ enabled: true }));
    await act(async () => client().pressButton("power"));
    await act(async () => release());
    const socket = helperSockets().at(-1)!;
    await admit(socket);
    expect(buttons(socket)).toEqual(["lock"]);
  });
}

for (const expired of [false, true]) {
  test(`early controls ${expired ? "expire at their original deadline" : "retain the 32-message capacity limit"}`, async () => {
    let release!: () => void;
    let now = 0;
    const NativeDate = Date;
    stubGlobal(
      "Date",
      class extends NativeDate {
        static now() {
          return now;
        }
      },
    );
    const helper = {
      pid: 1,
      discovery: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { client, helperSockets } = await renderIosClient(true, helper);
    await act(async () => {
      for (let index = 0; index < 40; index++) client().pressButton("home");
    });
    if (expired) now = 1501;
    await act(async () => release());
    const socket = helperSockets()[0]!;
    await admit(socket);
    expect(buttons(socket)).toEqual(expired ? [] : Array(32).fill("home"));
  });
}

test("admission prepares the keyboard before early layout keys and preserves control order", async () => {
  let release!: () => void;
  const helper = {
    pid: 1,
    discovery: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const { client, helperSockets } = await renderIosClient(true, helper);
  await act(async () => {
    client().pressButton("home");
    client().sendKey({ phase: "down", code: "KeyY", key: "z", repeat: false });
    client().sendKey({ phase: "up", code: "KeyY", key: "z", repeat: false });
    client().pressButton("power");
  });
  await act(async () => release());
  const socket = helperSockets()[0]!;
  await admit(socket);
  const messages = socket.sent.map((data) => ({
    tag: new Uint8Array(data)[0],
    payload: JSON.parse(new TextDecoder().decode(new Uint8Array(data).subarray(1))),
  }));
  expect(messages).toEqual([
    { tag: 0x0e, payload: { enabled: false } },
    { tag: 0x04, payload: { button: "home" } },
    { tag: 0x06, payload: { type: "down", usage: 0x1c, key: "z" } },
    { tag: 0x06, payload: { type: "up", usage: 0x1c } },
    { tag: 0x04, payload: { button: "lock" } },
  ]);
});

test("retired callbacks and paced keys never cross device identity", async () => {
  const { client, helperSockets, changeDevice } = await renderIosClient();
  const a = helperSockets()[0]!;
  a.readyState = 1;
  await act(async () => a.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const old = client();
  await act(async () => {
    old.sendKeyEvents!(
      Array.from({ length: 100 }, (_, i) => ({
        type: i % 2 ? ("up" as const) : ("down" as const),
        usage: 4,
      })),
    );
    changeDevice("DEVICE-B");
  });
  const b = helperSockets().find((socket) => socket.url.includes("DEVICE-B"))!;
  b.readyState = 1;
  await act(async () => b.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  await act(async () => {
    old.sendKey({ phase: "down", code: "KeyA", key: "a", repeat: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(b.sent.filter((data) => new Uint8Array(data)[0] === 6)).toHaveLength(0);
  await act(async () => {
    client().sendKey({ phase: "down", code: "KeyB", key: "b", repeat: false });
  });
  expect(b.sent.filter((data) => new Uint8Array(data)[0] === 6)).toHaveLength(1);
});

for (const event of ["blur", "visibilitychange", "pagehide"]) {
  test(`${event} cancels a paced batch and releases only its held keys`, async () => {
    const { client, helperSockets, dispatch } = await renderIosClient();
    const socket = helperSockets()[0]!;
    socket.readyState = 1;
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    await act(async () => {
      client().sendKeyEvents!([
        { type: "down", usage: 225 },
        { type: "down", usage: 4 },
        { type: "up", usage: 4 },
        { type: "up", usage: 225 },
      ]);
      if (event === "visibilitychange") Object.assign(document, { hidden: true });
      dispatch(event);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const keys = socket.sent
      .filter((data) => new Uint8Array(data)[0] === 6)
      .map((data) => JSON.parse(new TextDecoder().decode(new Uint8Array(data).slice(1))));
    expect(keys).toEqual([
      { type: "down", usage: 225 },
      { type: "up", usage: 225 },
    ]);
  });
}

test("blur before admission discards pending keys instead of typing them on recovery", async () => {
  const { client, helperSockets, dispatch } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => {
    client().sendKeyEvents!([
      { type: "down", usage: 4 },
      { type: "up", usage: 4 },
    ]);
    dispatch("blur");
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(socket.sent.filter((data) => new Uint8Array(data)[0] === 6)).toHaveLength(0);
});

function gestureMessages(socket: FakeSocket) {
  return socket.sent
    .filter((data) => [3, 5].includes(new Uint8Array(data)[0]!))
    .map((data) => JSON.parse(new TextDecoder().decode(new Uint8Array(data).slice(1))));
}

for (const gesture of ["single", "multi"] as const) {
  for (const cancellation of ["blur", "visibilitychange", "pagehide"]) {
    test(`${cancellation} abandons an unadmitted ${gesture} gesture`, async () => {
      const { helperSockets, dispatch } = await renderIosClient(true, { pid: 1 }, true);
      const socket = helperSockets()[0]!;
      socket.readyState = 1;
      const surface = renderer!.root.findByProps({ role: "application" });
      await act(async () =>
        surface.props.onPointerDown({
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          clientX: 20,
          clientY: 60,
          altKey: gesture === "multi",
          shiftKey: false,
          preventDefault() {},
        }),
      );
      await act(async () => {
        if (cancellation === "surface blur") surface.props.onBlur();
        else {
          if (cancellation === "visibilitychange") Object.assign(document, { hidden: true });
          dispatch(cancellation);
        }
        socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      });
      expect(gestureMessages(socket)).toEqual([]);
    });
  }

  test(`surface blur preserves an admitted ${gesture} gesture until pointerup`, async () => {
    const { helperSockets } = await renderIosClient(true, { pid: 1 }, true);
    const socket = helperSockets()[0]!;
    socket.readyState = 1;
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    const surface = renderer!.root.findByProps({ role: "application" });
    await act(async () =>
      surface.props.onPointerDown({
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 20,
        clientY: 60,
        altKey: gesture === "multi",
        shiftKey: false,
        preventDefault() {},
      }),
    );
    await act(async () => surface.props.onBlur());
    expect(gestureMessages(socket).map((message) => message.type)).toEqual(["begin"]);
    await act(async () =>
      surface.props.onPointerUp({ pointerId: 1, clientX: 20, clientY: 60, preventDefault() {} }),
    );
    expect(gestureMessages(socket).map((message) => message.type)).toEqual(["begin", "end"]);
  });
}

test("a completed tap before admission still reaches the device", async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => {
    client().sendTouch({ phase: "begin", x: 0.2, y: 0.3 });
    client().sendTouch({ phase: "end", x: 0.2, y: 0.3 });
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
  });
  expect(gestureMessages(socket).map((message) => message.type)).toEqual(["begin", "end"]);
});

for (const gesture of ["single", "multi"] as const) {
  for (const cancellation of ["surface blur", "blur"] as const) {
    test(`${cancellation} preserves a completed unadmitted ${gesture} gesture`, async () => {
      const { helperSockets, dispatch } = await renderIosClient(true, { pid: 1 }, true);
      const socket = helperSockets()[0]!;
      socket.readyState = 1;
      const surface = renderer!.root.findByProps({ role: "application" });
      const pointer = {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 20,
        clientY: 60,
        altKey: gesture === "multi",
        shiftKey: false,
        preventDefault() {},
      };
      await act(async () => {
        surface.props.onPointerDown(pointer);
        surface.props.onPointerUp(pointer);
      });
      await act(async () => {
        if (cancellation === "surface blur") surface.props.onBlur();
        else dispatch(cancellation);
        socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      });
      expect(gestureMessages(socket).map((message) => message.type)).toEqual(["begin", "end"]);
    });
  }
}

test("blur preserves completed input only for its original queue lifetime", async () => {
  const { client, helperSockets, dispatch } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    await act(async () => {
      client().sendTouch({ phase: "begin", x: 0.2, y: 0.3 });
      client().sendTouch({ phase: "end", x: 0.2, y: 0.3 });
      dispatch("blur");
      clock.mockReturnValue(2501);
      socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    });
    expect(gestureMessages(socket)).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("window blur keeps a completed tap while abandoning the following drag", async () => {
  const { helperSockets, dispatch } = await renderIosClient(true, { pid: 1 }, true);
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  const surface = renderer!.root.findByProps({ role: "application" });
  const pointer = {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 20,
    clientY: 60,
    altKey: false,
    shiftKey: false,
    preventDefault() {},
  };
  await act(async () => {
    surface.props.onPointerDown(pointer);
    surface.props.onPointerUp(pointer);
    surface.props.onPointerDown({ ...pointer, pointerId: 2, clientX: 40 });
    dispatch("blur");
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
  });
  expect(gestureMessages(socket)).toEqual([
    { type: "begin", x: 0.2, y: 0.3 },
    { type: "end", x: 0.2, y: 0.3 },
  ]);
});

test("initial discovery keeps the surface gesture and input callbacks owned by its early queue", async () => {
  let resolve!: () => void;
  const helper = {
    pid: 1,
    discovery: new Promise<void>((done) => {
      resolve = done;
    }),
  };
  const { client, helperSockets } = await renderIosClient(true, helper, true);
  const original = client();
  const surface = renderer!.root.findByProps({ role: "application" });
  const pointer = {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    clientX: 20,
    clientY: 60,
    preventDefault() {},
  };
  await act(async () => surface.props.onPointerDown(pointer));
  await act(async () => resolve());
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  expect(client().sendTouch).toBe(original.sendTouch);
  expect(client().cancelInput).toBe(original.cancelInput);
  expect(gestureMessages(socket).map((message) => message.type)).toEqual(["begin"]);
  await act(async () => surface.props.onPointerUp(pointer));
  expect(gestureMessages(socket).map((message) => message.type)).toEqual(["begin", "end"]);
});

for (const returnToOriginal of [false, true]) {
  test(`iOS callbacks retire across token ${returnToOriginal ? "A to B to A" : "A to B"} handoff`, async () => {
    const { client, helperSockets, changeOptions } = await renderIosClient();
    await act(async () => changeOptions({ token: "token-A" }));
    const original = client();
    await act(async () => changeOptions({ token: "token-B" }));
    if (returnToOriginal) await act(async () => changeOptions({ token: "token-A" }));
    const socket = helperSockets().at(-1)!;
    socket.readyState = 1;
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    await act(async () => {
      original.sendTouch({ phase: "begin", x: 0.2, y: 0.3 });
      expect(original.sendKey({ phase: "down", code: "KeyA", key: "a", repeat: false })).toBe(
        false,
      );
      original.sendKeyEvents!([
        { type: "down", usage: 4 },
        { type: "up", usage: 4 },
      ]);
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(gestureMessages(socket)).toEqual([]);
    expect(socket.sent.filter((message) => new Uint8Array(message)[0] === 6)).toEqual([]);
    await act(async () => client().sendTouch({ phase: "begin", x: 0.4, y: 0.5 }));
    expect(gestureMessages(socket)).toHaveLength(1);
  });
}

test("window blur cancels abandoned pre-discovery input while keeping the completed tap", async () => {
  let resolve!: () => void;
  const helper = {
    pid: 1,
    discovery: new Promise<void>((done) => {
      resolve = done;
    }),
  };
  const { client, helperSockets, dispatch } = await renderIosClient(true, helper);
  await act(async () => {
    client().sendKeyEvents!([
      { type: "down", usage: 4 },
      { type: "up", usage: 4 },
    ]);
    client().sendScroll!({ dx: 0, dy: 0.1, x: 0.5, y: 0.5 });
    client().sendTouch({ phase: "begin", x: 0.2, y: 0.3 });
    client().sendTouch({ phase: "end", x: 0.2, y: 0.3 });
    client().sendTouch({ phase: "begin", x: 0.4, y: 0.5 });
    dispatch("blur");
    resolve();
  });
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => {
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(socket.sent.filter((message) => [6, 11].includes(new Uint8Array(message)[0]!))).toEqual(
    [],
  );
  expect(gestureMessages(socket)).toEqual([
    { type: "begin", x: 0.2, y: 0.3 },
    { type: "end", x: 0.2, y: 0.3 },
  ]);
});

test("a real helper replacement at the same URL retires the previous callbacks", async () => {
  const helper = { pid: 1 };
  const { client, helperSockets } = await renderIosClient(true, helper);
  const first = helperSockets()[0]!;
  first.readyState = 1;
  await act(async () => first.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const previous = client();
  helper.pid = 2;
  await act(async () => {
    first.onclose?.({ code: 1006, reason: "" });
    await new Promise((done) => setTimeout(done, 30));
  });
  const replacement = helperSockets().at(-1)!;
  expect(replacement).not.toBe(first);
  replacement.readyState = 1;
  await act(async () => replacement.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  await act(async () => {
    previous.sendTouch({ phase: "begin", x: 0.2, y: 0.3 });
    previous.sendKey({ phase: "down", code: "KeyA", key: "a", repeat: false });
    previous.cancelInput?.();
  });
  expect(gestureMessages(replacement)).toEqual([]);
  expect(replacement.sent.filter((message) => new Uint8Array(message)[0] === 6)).toEqual([]);
  await act(async () => client().sendTouch({ phase: "begin", x: 0.4, y: 0.5 }));
  expect(gestureMessages(replacement)).toHaveLength(1);
});

for (const gesture of ["single", "multi"] as const) {
  for (const cancellation of [
    "onLostPointerCapture",
    "onPointerCancel",
    "failed capture blur",
    "failed capture leave",
  ] as const) {
    test(`${cancellation} discards an unfinished unadmitted ${gesture} gesture`, async () => {
      const harness = await renderIosClient(true, { pid: 1 }, true);
      const socket = harness.helperSockets()[0]!;
      socket.readyState = 1;
      const surface = renderer!.root.findByProps({ role: "application" });
      if (cancellation.startsWith("failed capture")) {
        harness.surface.setPointerCapture = () => {
          throw new Error("capture unavailable");
        };
      }
      const pointer = {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 20,
        clientY: 60,
        altKey: gesture === "multi",
        shiftKey: false,
        preventDefault() {},
      };
      await act(async () => surface.props.onPointerDown(pointer));
      await act(async () => {
        if (cancellation === "failed capture blur") surface.props.onBlur();
        else if (cancellation === "failed capture leave") surface.props.onPointerLeave(pointer);
        else surface.props[cancellation](pointer);
      });
      await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
      expect(gestureMessages(socket)).toEqual([]);
      await act(async () => surface.props.onPointerUp(pointer));
      expect(gestureMessages(socket)).toEqual([]);
    });
  }
}

for (const cancellation of ["blur", "onLostPointerCapture", "onPointerCancel"] as const) {
  test(`a real two-finger gesture abandoned by ${cancellation} does not replay its single-touch prefix`, async () => {
    const { helperSockets, dispatch } = await renderIosClient(true, { pid: 1 }, true);
    const socket = helperSockets()[0]!;
    socket.readyState = 1;
    const surface = renderer!.root.findByProps({ role: "application" });
    const pointer = {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 20,
      clientY: 60,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    };
    await act(async () => {
      surface.props.onPointerDown(pointer);
      surface.props.onPointerDown({ ...pointer, pointerId: 2, clientX: 70 });
    });
    await act(async () => {
      if (cancellation === "blur") dispatch("blur");
      else surface.props[cancellation](pointer);
      socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    });
    expect(gestureMessages(socket)).toEqual([]);
    await act(async () => surface.props.onPointerUp({ ...pointer, pointerId: 2, clientX: 70 }));
    expect(gestureMessages(socket)).toEqual([]);
  });
}

test("a completed real pinch keeps its multi-touch pair and an earlier tap without a synthetic tap", async () => {
  const { helperSockets, client } = await renderIosClient(true, { pid: 1 }, true);
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  const surface = renderer!.root.findByProps({ role: "application" });
  const pointer = {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    clientX: 20,
    clientY: 60,
    altKey: false,
    shiftKey: false,
    preventDefault() {},
  };
  await act(async () => {
    surface.props.onPointerDown(pointer);
    surface.props.onPointerUp(pointer);
    client().sendKey({ phase: "down", code: "KeyA", key: "a", repeat: false });
    surface.props.onPointerDown(pointer);
    surface.props.onPointerDown({ ...pointer, pointerId: 2, clientX: 70 });
    surface.props.onPointerUp(pointer);
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
  });
  const gestures = gestureMessages(socket);
  expect(gestures.map((message) => message.type)).toEqual(["begin", "end", "begin", "end"]);
  expect(gestures[2]).toHaveProperty("x1");
  expect(socket.sent.filter((message) => new Uint8Array(message)[0] === 6)).toHaveLength(1);
});

test("StrictMode effect cleanup keeps keyboard input usable", async () => {
  const { client, helperSockets } = await renderIosClient(true, { pid: 1 }, false, false, true);
  const socket = helperSockets().at(-1)!;
  socket.readyState = 1;
  await act(async () => {
    socket.onopen?.();
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
  });
  expect(client().sendKey({ phase: "down", key: "a", code: "KeyA", repeat: false })).toBe(true);
  const frames = socket.sent.map((data) => new Uint8Array(data));
  expect(frames.some((data) => data[0] === 0x06)).toBe(true);
});
