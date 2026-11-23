import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

class Socket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

async function mount(
  api: { shake?: boolean },
  answer?: (body: string) => Promise<Response>,
  intervals: Array<() => void> = [],
) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  // The hold renews on an interval; the test runs each renewal by hand. A shake's interval is
  // the newest one, because the shake starts after the client mounted.
  stubGlobal("setInterval", (callback: () => void) => {
    intervals.push(callback);
    return intervals.length;
  });
  stubGlobal("clearInterval", (id: number) => {
    intervals[id - 1] = () => {};
  });
  const writes: string[] = [];
  const bodies: string[] = [];
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/api/shake") bodies.push(String(init?.body));
    if (path === "/api") {
      return Response.json({ size: { width: 1080, height: 2400 }, pose: "portrait", ...api });
    }
    if (path === "/api/shake")
      return answer ? answer(String(init?.body)) : Response.json({ ok: true });
    return Response.json({}, { status: 404 });
  });
  let client!: DeviceClient;
  function Harness() {
    client = useAndroidDeviceClient({
      baseUrl: "https://hub.test/",
      device: "emulator-5554",
      enabled: true,
      streamMode: "h264",
    });
    return null;
  }
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    renderer = create(<Harness />);
  });
  await settle();
  return { client: () => client, writes, bodies, intervals, settle };
}

test("an emulator that serve-emu can shake offers shake, and one shake sends one request", async () => {
  const harness = await mount({ shake: true });
  expect(harness.client().capabilities.shake).toBe(true);

  await act(async () => harness.client().shake());
  await harness.settle();

  expect(harness.writes).toEqual(["POST /api/shake"]);
});

test("a device or server without shake support does not offer it or send a request", async () => {
  for (const api of [{}, { shake: false }]) {
    const harness = await mount(api);
    expect(harness.client().capabilities.shake).toBe(false);

    await act(async () => harness.client().shake());
    await harness.settle();

    expect(harness.writes).toEqual([]);
    await act(async () => renderer?.unmount());
    renderer = undefined;
    restoreGlobals();
  }
});

test("a failed Android shake shows its error until the next shake starts", async () => {
  let reply = () =>
    Promise.resolve(
      Response.json(
        { ok: false, error: "Emulator shake failed: setPhysicalModel: grpc-status 14" },
        { status: 400 },
      ),
    );
  const harness = await mount({ shake: true }, () => reply());
  expect(harness.client().shakeError).toBeNull();

  await act(async () => harness.client().shake());
  await harness.settle();
  expect(harness.client().shakeError).toBe(
    "Emulator shake failed: setPhysicalModel: grpc-status 14",
  );

  reply = () => Promise.reject(new TypeError("Failed to fetch"));
  await act(async () => harness.client().shake());
  await harness.settle();
  expect(harness.client().shakeError).toBe("The emulator could not be reached to shake it.");

  reply = () => Promise.resolve(Response.json({ ok: true }));
  await act(async () => harness.client().shake());
  await harness.settle();
  expect(harness.client().shakeError).toBeNull();
});

test("a held shake renews its hold until it is released, then stops renewing", async () => {
  const harness = await mount({ shake: true });

  await act(async () => harness.client().startShake());
  await harness.settle();
  await act(async () => harness.intervals.at(-1)!());
  await harness.settle();
  await act(async () => harness.client().stopShake());
  await harness.settle();
  await act(async () => harness.intervals.at(-1)!());
  await harness.settle();

  expect(harness.bodies).toEqual(['{"hold":true}', '{"hold":true}', '{"hold":false}']);
});

test("a release waits for the hold request before it, so it never arrives first", async () => {
  let answerPress!: () => void;
  const harness = await mount({ shake: true }, (body) =>
    body === '{"hold":true}'
      ? new Promise<Response>((resolve) => {
          answerPress = () => resolve(Response.json({ ok: true }));
        })
      : Promise.resolve(Response.json({ ok: true })),
  );

  await act(async () => harness.client().startShake());
  await harness.settle();
  // A renewal while the press is unanswered is skipped.
  await act(async () => harness.intervals.at(-1)!());
  await act(async () => harness.client().stopShake());
  await harness.settle();
  expect(harness.bodies).toEqual(['{"hold":true}']);

  answerPress();
  await harness.settle();
  await harness.settle();
  expect(harness.bodies).toEqual(['{"hold":true}', '{"hold":false}']);
});

test("a hold that fails shows its error and stops renewing", async () => {
  const harness = await mount({ shake: true }, (body) =>
    Promise.resolve(
      body === '{"hold":true}'
        ? Response.json(
            { ok: false, error: "could not enable the emulator gRPC endpoint" },
            { status: 400 },
          )
        : Response.json({ ok: true }),
    ),
  );

  await act(async () => harness.client().startShake());
  await harness.settle();
  expect(harness.client().shakeError).toBe("could not enable the emulator gRPC endpoint");
  await act(async () => harness.intervals.at(-1)!());
  await harness.settle();
  expect(harness.bodies).toEqual(['{"hold":true}']);

  await act(async () => harness.client().stopShake());
  await harness.settle();
  expect(harness.client().shakeError).toBe("could not enable the emulator gRPC endpoint");
});

test("unmounting during a held shake releases it", async () => {
  const harness = await mount({ shake: true });

  await act(async () => harness.client().startShake());
  await harness.settle();
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(harness.bodies).toEqual(['{"hold":true}', '{"hold":false}']);
});

test("a device that cannot shake does not hold", async () => {
  const harness = await mount({ shake: false });
  const intervals = harness.intervals.length;

  await act(async () => harness.client().startShake());
  await act(async () => harness.client().stopShake());
  await harness.settle();

  expect(harness.bodies).toEqual([]);
  expect(harness.intervals).toHaveLength(intervals);
});

test("a new press waits for the previous release, so an old release cannot end the new hold", async () => {
  const answers: Array<() => void> = [];
  const harness = await mount({ shake: true }, (body) =>
    body === '{"hold":true}' && answers.length === 0
      ? new Promise<Response>((resolve) => {
          answers.push(() => resolve(Response.json({ ok: true })));
        })
      : Promise.resolve(Response.json({ ok: true })),
  );

  // Press A's answer is late; A is released and B is pressed before it comes.
  await act(async () => harness.client().startShake());
  await act(async () => harness.client().stopShake());
  await act(async () => harness.client().startShake());
  await harness.settle();
  expect(harness.bodies).toEqual(['{"hold":true}']);

  answers[0]!();
  await harness.settle();
  await harness.settle();
  await harness.settle();
  expect(harness.bodies).toEqual(['{"hold":true}', '{"hold":false}', '{"hold":true}']);
});

test("a hold stops renewing after 20 s, so a lost release does not shake forever", async () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = await mount({ shake: true });
    await act(async () => harness.client().startShake());
    await harness.settle();
    const renew = harness.intervals.at(-1)!;

    now += 19_500;
    await act(async () => renew());
    await harness.settle();
    now += 500;
    await act(async () => renew());
    await harness.settle();
    await act(async () => renew());
    await harness.settle();

    expect(harness.bodies).toEqual(['{"hold":true}', '{"hold":true}']);
  } finally {
    Date.now = realNow;
  }
});
