import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  IOS_INPUT_BUSY_MESSAGE,
  IOS_INPUT_UNAVAILABLE_MESSAGE,
  iosInputCloseError,
} from "../ios-input-error.js";
import { type DeviceClient } from "../types.js";
import { useIosDeviceClient } from "../useIosDevice.js";
import { createGlobalStubs } from "./test-globals.js";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const CLIENT_LIMIT_REASON = "Simulator input unavailable; retry after other clients disconnect";

test("only a serve-sim 1013 close rejects input", () => {
  expect(iosInputCloseError(1013, CLIENT_LIMIT_REASON)).toBe(CLIENT_LIMIT_REASON);
  expect(iosInputCloseError(1013, "")).toBe(IOS_INPUT_BUSY_MESSAGE);
  expect(iosInputCloseError(1000, "")).toBeNull();
  expect(iosInputCloseError(1006, "")).toBeNull();
});

type FakeSocket = {
  url: string;
  readyState: number;
  sent: unknown[];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
};

async function renderIosClient(inputAdmission?: unknown) {
  const sockets: FakeSocket[] = [];
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
        sockets.push(this);
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
  stubGlobal("fetch", async (url: string) => {
    if (url === "/sim/api?device=DEVICE-A") {
      return Response.json({
        device: "DEVICE-A",
        ...(inputAdmission !== undefined ? { inputAdmission } : {}),
        url: "http://localhost:3200/sim/helper/DEVICE-A",
        streamUrl: "http://localhost:3200/sim/helper/DEVICE-A/stream.mjpeg",
        wsUrl: "ws://localhost:3200/sim/helper/DEVICE-A/ws",
      });
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({ baseUrl: "/sim", device: "DEVICE-A", streamMode: "mjpeg" });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const helperSockets = () => sockets.filter((socket) => socket.url.includes("/helper/"));
  return { client: () => client, helperSockets };
}

function configFrame(config: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(config));
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = 0x82;
  bytes.set(json, 1);
  return bytes.buffer;
}

const SCREEN = { width: 390, height: 844, orientation: "portrait" };

async function rejectFirstSocket(inputAdmission?: unknown) {
  const rendered = await renderIosClient(inputAdmission);
  const { client, helperSockets } = rendered;
  expect(helperSockets()).toHaveLength(1);
  expect(client().inputError).toBeNull();
  await act(async () => helperSockets()[0]!.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  return rendered;
}

const waitForRetry = () => act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));

test("a rejected input socket reports inputError until a later socket gets a config frame", async () => {
  const { client, helperSockets } = await rejectFirstSocket();

  // A plain drop during the retry keeps the rejection visible.
  await waitForRetry();
  expect(helperSockets()).toHaveLength(2);
  await act(async () => helperSockets()[1]!.onclose?.({ code: 1006, reason: "" }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  // serve-sim opens a refused socket before it closes it, so opening alone is not recovery.
  await waitForRetry();
  const refused = helperSockets()[2]!;
  refused.readyState = 1;
  await act(async () => refused.onopen?.());
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  await act(async () => refused.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  await waitForRetry();
  const admitted = helperSockets()[3]!;
  admitted.readyState = 1;
  await act(async () => admitted.onopen?.());
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  await act(async () => admitted.onmessage?.({ data: configFrame(SCREEN) }));
  expect(client().inputError).toBeNull();
});

test("an input socket that stays open without a config frame clears inputError", async () => {
  const { client, helperSockets } = await rejectFirstSocket();

  await waitForRetry();
  const admitted = helperSockets()[1]!;
  admitted.readyState = 1;
  await act(async () => admitted.onopen?.());
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  expect(client().inputError).toBeNull();
});

test("serve-sim inputUnavailable in the screen config reports inputError", async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ ...SCREEN, inputUnavailable: true }),
    }),
  );
  expect(client().inputError).toBe(IOS_INPUT_UNAVAILABLE_MESSAGE);

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ ...SCREEN, inputUnavailable: false }),
    }),
  );
  expect(client().inputError).toBeNull();
});

test("modern input stays refused through OPEN and config until its admission acknowledgement", async () => {
  const { client, helperSockets } = await rejectFirstSocket(true);
  await waitForRetry();
  const refused = helperSockets()[1]!;
  refused.readyState = 1;
  await act(async () => refused.onopen?.());
  await act(async () => refused.onmessage?.({ data: configFrame(SCREEN) }));
  await act(async () => refused.onmessage?.({ data: "unrelated message" }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  expect(refused.sent).toHaveLength(0);
  await act(async () => refused.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  await waitForRetry();
  const admitted = helperSockets()[2]!;
  admitted.readyState = 1;
  await act(async () => admitted.onopen?.());
  await act(async () => admitted.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  expect(client().inputError).toBeNull();
});

test("an invalid advertised admission flag cannot enable legacy timed recovery", async () => {
  const { client, helperSockets } = await rejectFirstSocket("invalid");
  await waitForRetry();
  const socket = helperSockets()[1]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
});
