import { afterEach, expect, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { displayScreen } from "../orientation";
import type { DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
const realSetInterval = setInterval;
const METADATA_POLL_MS = 1500;

class Socket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

let renderer: ReactTestRenderer | undefined;
let clock: ReturnType<typeof spyOn<typeof performance, "now">> | undefined;
afterEach(async () => {
  clock?.mockRestore();
  clock = undefined;
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

type LockAnswer = { status: number; body: unknown };

async function mount(initialInfo: Record<string, unknown>) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  // Polls run only when the test asks, so each report is deterministic.
  const metadataPolls = new Set<() => void>();
  stubGlobal("setInterval", (callback: () => void, ms?: number) => {
    if (ms === METADATA_POLL_MS) metadataPolls.add(callback);
    return realSetInterval(() => {}, 1_000_000);
  });
  let apiInfo: Record<string, unknown> = { size: { width: 1080, height: 2400 }, ...initialInfo };
  const locks: Array<{ device: string | null; orientation: string }> = [];
  const pending: Array<() => void> = [];
  let holdLocks = false;
  let holdApi = false;
  const heldApi: Array<() => void> = [];
  let offset = 0;
  const realNow = performance.now.bind(performance);
  clock = spyOn(performance, "now").mockImplementation(() => realNow() + offset);
  const silentDevices = new Set<string>();
  let answer = (orientation: string): LockAnswer => ({
    status: 200,
    body: { ok: true, orientation: { mode: "lock", pose: orientation } },
  });
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/orientation" && init?.method === "POST") {
      const orientation = JSON.parse(init.body as string).orientation as string;
      locks.push({ device: parsed.searchParams.get("device"), orientation });
      if (holdLocks) await new Promise<void>((resolve) => pending.push(resolve));
      const { status, body } = answer(orientation);
      return Response.json(body, { status });
    }
    if (parsed.pathname === "/api") {
      if (holdApi) await new Promise<void>((resolve) => heldApi.push(resolve));
      const device = parsed.searchParams.get("device");
      if (device && silentDevices.has(device)) return Response.json({}, { status: 503 });
      return Response.json(apiInfo);
    }
    return Response.json({}, { status: 404 });
  });
  let client!: DeviceClient;
  function Harness({ device, token }: { device: string; token?: string }) {
    client = useAndroidDeviceClient({
      baseUrl: "https://hub.test/",
      device,
      token,
      enabled: true,
      streamMode: "h264",
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness device="emulator-5554" />);
  });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return {
    client: () => client,
    locks: () => locks.map((lock) => lock.orientation),
    lockDevices: () => locks.map((lock) => lock.device),
    hold: () => (holdLocks = true),
    release: async () => {
      holdLocks = false;
      while (pending.length) pending.shift()!();
      await settle();
    },
    silence: (device: string, silent: boolean) =>
      silent ? silentDevices.add(device) : silentDevices.delete(device),
    answerWith: (next: (orientation: string) => LockAnswer) => (answer = next),
    holdApi: () => (holdApi = true),
    releaseApi: async () => {
      holdApi = false;
      while (heldApi.length) heldApi.shift()!();
      await settle();
    },
    startPoll: async (next: Record<string, unknown>) => {
      apiInfo = { ...apiInfo, ...next };
      await act(async () => {
        for (const poll of metadataPolls) poll();
      });
    },
    advance: (ms: number) => (offset += ms),
    report: async (next: Record<string, unknown>) => {
      apiInfo = { ...apiInfo, ...next };
      await act(async () => {
        for (const poll of metadataPolls) poll();
      });
      await settle();
    },
    switchDevice: (device: string) =>
      act(async () => {
        renderer?.update(<Harness device={device} />);
      }),
    switchToken: (token: string) =>
      act(async () => {
        renderer?.update(<Harness device="emulator-5554" token={token} />);
      }),
    settle,
  };
}

test("Android reports the server's pose and offers every pose in the shared order", async () => {
  const { client } = await mount({ pose: "portrait_upside_down" });
  expect(client().capabilities.orientation).toEqual({
    orientations: ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"],
  });
  expect(client().orientation).toBe("portrait_upside_down");
  expect(client().screen).toEqual({
    width: 1080,
    height: 2400,
    orientation: "portrait_upside_down",
    framesUpright: true,
  });
});

test("Android adds the reported pose to the screen only while it agrees with the frame", async () => {
  const { client, report } = await mount({
    size: { width: 2400, height: 1080 },
    pose: "landscape_left",
  });
  expect(client().screen?.orientation).toBe("landscape_left");

  // The frame turns back to portrait before the slower pose report follows.
  await report({ size: { width: 1080, height: 2400 } });
  expect(client().screen).toEqual({ width: 1080, height: 2400 });
  expect(displayScreen(client().screen)).toEqual({ width: 1080, height: 2400 });

  await report({ pose: "portrait" });
  expect(client().screen?.orientation).toBe("portrait");
});

test("Android shows a choice at once, then the server's answer, then a matching report", async () => {
  const { client, locks, hold, release, answerWith, report } = await mount({
    pose: "portrait",
  });
  hold();
  await act(async () => client().setOrientation("landscape_right"));
  expect(locks()).toEqual(["landscape_right"]);
  expect(client().orientation).toBe("landscape_right");
  expect(client().orientationPending).toBe(true);

  // A report during the request does not replace the choice.
  await report({ pose: "portrait" });
  expect(client().orientation).toBe("landscape_right");
  expect(client().orientationPending).toBe(true);

  // The answer's pose is the pose serve-emu locked; it replaces the choice.
  answerWith(() => ({ status: 200, body: { ok: true, orientation: { pose: "landscape_left" } } }));
  await release();
  expect(client().orientationPending).toBe(false);
  expect(client().orientation).toBe("landscape_left");

  // A report that shows the answered pose takes over, and later reports follow the device.
  await report({ size: { width: 2400, height: 1080 }, pose: "landscape_left" });
  await report({ pose: "landscape_right" });
  expect(client().orientation).toBe("landscape_right");
});

test("Android keeps the answer over an older report until the readback grace ends", async () => {
  const { client, hold, release, holdApi, releaseApi, startPoll, report, advance } = await mount({
    pose: "portrait",
  });
  hold();
  await act(async () => client().setOrientation("landscape_left"));
  // A poll starts before the answer and returns the pose from before the lock.
  holdApi();
  await startPoll({ pose: "portrait" });
  await release();
  expect(client().orientation).toBe("landscape_left");
  await releaseApi();
  expect(client().orientation).toBe("landscape_left");

  // A later report that still shows the old pose waits for the grace, then wins.
  await report({ pose: "portrait" });
  expect(client().orientation).toBe("landscape_left");
  advance(1_500);
  await report({ pose: "portrait" });
  expect(client().orientation).toBe("portrait");
});

test("Android ignores a report from a poll that started before the answer, also after the grace", async () => {
  const { client, hold, release, holdApi, releaseApi, startPoll, advance } = await mount({
    pose: "portrait",
  });
  hold();
  await act(async () => client().setOrientation("landscape_left"));
  holdApi();
  await startPoll({ pose: "portrait" });
  await release();
  // The old poll answers after the grace has passed; it still read the pre-lock pose.
  advance(1_600);
  await releaseApi();
  expect(client().orientation).toBe("landscape_left");
});

test("Android Rotate before the first /api answer waits, because the recording status is unknown", async () => {
  const { client, locks, silence, switchDevice, settle } = await mount({
    pose: "portrait",
  });
  silence("emulator-5556", true);
  await switchDevice("emulator-5556");
  expect(client().capabilities.orientation).toBe(false);
  expect(client().recordingControlsLocked).toBe(true);
  await act(async () => client().rotate());
  await settle();
  expect(locks()).toEqual([]);
});

test("Android sends a new device's choice without waiting for the old device's request", async () => {
  const { client, lockDevices, hold, release, switchDevice } = await mount({
    pose: "portrait",
  });
  hold();
  await act(async () => client().setOrientation("landscape_left"));
  await switchDevice("emulator-5556");
  await act(async () => client().rotate());
  // The old device's request is still held; the new device's goes out beside it.
  expect(lockDevices()).toEqual(["emulator-5554", "emulator-5556"]);
  await release();
  expect(client().orientationPending).toBe(false);
});

test("Android reports a refused orientation and clears the error with the next choice", async () => {
  const { client, answerWith } = await mount({ pose: "portrait" });
  answerWith(() => ({ status: 400, body: { ok: false, error: "orientation must be one of" } }));
  await act(async () => client().setOrientation("landscape_left"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(client().orientationPending).toBe(false);
  expect(client().orientationError).toBe("orientation must be one of");
  expect(client().orientation).toBe("portrait");

  answerWith((orientation) => ({
    status: 200,
    body: { ok: true, orientation: { pose: orientation } },
  }));
  await act(async () => client().setOrientation("landscape_left"));
  expect(client().orientationError).toBeNull();
});

test("Android offers no poses on servers that do not report one, but Rotate still turns", async () => {
  const { client, locks, settle } = await mount({});
  expect(client().capabilities.orientation).toBe(false);
  expect(client().orientationUnavailable).toBeNull();
  expect(client().screen?.orientation).toBeUndefined();
  await act(async () => client().setOrientation("landscape_right"));
  await settle();
  expect(locks()).toEqual([]);
  await act(async () => client().rotate());
  await settle();
  // The client cannot show the pose, so it does not show the Rotate choice either.
  expect(client().orientation).toBeNull();
  await act(async () => client().rotate());
  await settle();
  expect(locks()).toEqual(["landscape", "portrait"]);
  expect(client().orientation).toBeNull();
});

test("Android sends one orientation at a time and keeps only the latest queued choice", async () => {
  const { client, locks, hold, release } = await mount({ pose: "portrait" });
  hold();
  await act(async () => {
    client().setOrientation("landscape_left");
    client().setOrientation("portrait_upside_down");
    client().setOrientation("landscape_right");
  });
  expect(locks()).toEqual(["landscape_left"]);
  await release();
  expect(locks()).toEqual(["landscape_left", "landscape_right"]);
  expect(client().orientation).toBe("landscape_right");
});

test("Android Rotate continues the four-pose cycle through the same writer", async () => {
  const { client, locks, hold, release } = await mount({ pose: "portrait" });
  hold();
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  expect(locks()).toEqual(["landscape_left"]);
  expect(client().orientation).toBe("landscape_right");
  await release();
  expect(locks()).toEqual(["landscape_left", "landscape_right"]);
});

test("Android forgets the previous device's pose and sends to the new device", async () => {
  const { client, switchDevice, report, lockDevices, silence } = await mount({
    pose: "portrait_upside_down",
  });
  expect(client().orientation).toBe("portrait_upside_down");
  silence("emulator-5556", true);
  await switchDevice("emulator-5556");
  expect(client().orientation).toBeNull();
  expect(client().capabilities.orientation).toBe(false);
  silence("emulator-5556", false);
  await report({ pose: "portrait" });
  expect(client().orientation).toBe("portrait");
  await act(async () => client().setOrientation("landscape_left"));
  expect(lockDevices()).toEqual(["emulator-5556"]);
});

test("Android drops a queued choice when the device changes, and still finishes the one in flight", async () => {
  const { client, locks, lockDevices, hold, release, switchDevice, report } = await mount({
    pose: "portrait",
  });
  hold();
  await act(async () => client().setOrientation("landscape_left"));
  await act(async () => client().setOrientation("landscape_right"));
  await switchDevice("emulator-5556");
  await release();
  expect(locks()).toEqual(["landscape_left"]);
  expect(lockDevices()).toEqual(["emulator-5554"]);
  // The answer for the old device does not show on the new one.
  await report({ pose: "portrait" });
  expect(client().orientation).toBe("portrait");
  expect(client().orientationPending).toBe(false);
});

test("Android drops a queued choice when the client unmounts", async () => {
  const { client, locks, hold, release } = await mount({ pose: "portrait" });
  hold();
  await act(async () => client().setOrientation("landscape_left"));
  await act(async () => client().setOrientation("landscape_right"));
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await release();
  expect(locks()).toEqual(["landscape_left"]);
});

test("Android keeps one emulator's requests in order across a token change", async () => {
  const { client, locks, hold, release, switchToken, report } = await mount({
    pose: "portrait",
  });
  hold();
  await act(async () => client().setOrientation("landscape_left"));
  await switchToken("next-token");
  await report({ pose: "portrait" });
  await act(async () => client().setOrientation("landscape_right"));
  // The new token's lock waits for the old one, so the emulator ends in the newer pose.
  expect(locks()).toEqual(["landscape_left"]);
  await release();
  expect(locks()).toEqual(["landscape_left", "landscape_right"]);
});

test("Android Rotate called twice before a render steps through two poses", async () => {
  const { client, locks, hold, release } = await mount({ pose: "portrait" });
  hold();
  await act(async () => {
    client().rotate();
    client().rotate();
  });
  expect(client().orientation).toBe("portrait_upside_down");
  await release();
  expect(locks()).toEqual(["landscape_left", "portrait_upside_down"]);
});

test("Android keeps a device's requests in order after switching away and back", async () => {
  const { client, locks, lockDevices, hold, release, switchDevice } = await mount({
    pose: "portrait",
  });
  hold();
  await act(async () => client().setOrientation("landscape_left"));
  await switchDevice("emulator-5556");
  await switchDevice("emulator-5554");
  await act(async () => client().setOrientation("portrait_upside_down"));
  // The second lock for emulator-5554 waits for its first one.
  expect(locks()).toEqual(["landscape_left"]);
  await release();
  expect(locks()).toEqual(["landscape_left", "portrait_upside_down"]);
  expect(lockDevices()).toEqual(["emulator-5554", "emulator-5554"]);
});

test("Android keeps the last error and pose when a choice is made while a recording locks it", async () => {
  const { client, locks, answerWith, report, settle } = await mount({ pose: "portrait" });
  answerWith(() => ({ status: 400, body: { ok: false, error: "orientation refused" } }));
  await act(async () => client().setOrientation("landscape_left"));
  await settle();
  expect(client().orientationError).toBe("orientation refused");
  await report({ screenRecording: { status: "recording" } });
  expect(client().recordingControlsLocked).toBe(true);
  await act(async () => client().setOrientation("landscape_right"));
  expect(client().orientationError).toBe("orientation refused");
  expect(client().orientation).toBe("portrait");
  expect(locks()).toEqual(["landscape_left"]);
});
