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

type FakeSocket = {
  url: string;
  readyState: number;
  sent: ArrayBuffer[];
  onmessage?: (event: { data: unknown }) => void;
};

async function renderClient(flags: { inputShake?: boolean }) {
  const sockets: FakeSocket[] = [];
  // The input queue drops a message after 1.5 s; shorten that wait.
  const realTimeout = globalThis.setTimeout;
  stubGlobal("setTimeout", (callback: () => void, delay: number) =>
    realTimeout(callback, delay === 1500 ? 10 : delay),
  );
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
      sent: ArrayBuffer[] = [];
      constructor(readonly url: string) {
        sockets.push(this);
      }
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
      const device = endpoint.searchParams.get("device");
      return Response.json({
        inputAdmission: true,
        ...flags,
        device,
        execToken: "exec-token",
        url: `http://localhost:3200/sim/helper/${device}`,
        streamUrl: `http://localhost:3200/sim/helper/${device}/stream.mjpeg`,
        wsUrl: `ws://localhost:3200/sim/helper/${device}/ws`,
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
  const admit = async () => {
    const socket = sockets.filter((candidate) => candidate.url.includes("/helper/")).at(-1)!;
    socket.readyState = 1;
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    return socket;
  };
  return { client: () => client, admit };
}

// The hardware-keyboard sync (0x0e) can go out on connect; it is not part of a shake.
const tags = (socket: FakeSocket) =>
  socket.sent.map((data) => new Uint8Array(data)[0]).filter((tag) => tag !== 0x0e);

test("a helper that advertises inputShake can shake, and one shake sends one 0x14 message", async () => {
  const { client, admit } = await renderClient({ inputShake: true });
  expect(client().capabilities.shake).toBe(true);
  const socket = await admit();

  await act(async () => client().shake());

  expect(tags(socket)).toEqual([0x14]);
});

test("an older helper cannot shake and gets no shake message", async () => {
  const { client, admit } = await renderClient({});
  expect(client().capabilities.shake).toBe(false);
  const socket = await admit();

  await act(async () => client().shake());

  expect(tags(socket)).toEqual([]);
});

test("a shake the input socket never sends shows an error; a sent one does not", async () => {
  const { client, admit } = await renderClient({ inputShake: true });

  await act(async () => client().shake());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  expect(client().shakeError).toBe(
    "The shake was not sent because simulator input is not connected. Try again.",
  );

  const socket = await admit();
  await act(async () => client().shake());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  expect(tags(socket)).toContain(0x14);
  expect(client().shakeError).toBeNull();
});
