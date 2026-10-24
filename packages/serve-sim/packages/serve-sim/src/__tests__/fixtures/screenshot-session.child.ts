import { afterAll, expect, mock, test } from "bun:test";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import { UDID, useTempStateDir, withActionTimeoutAsync } from "../helpers";
let starts = 0,
  stops = 0,
  fail = false;
let updateSettings = async () => {};
let startCapture = async () => {};
let readDisplay = async () => 3;
let subscriptions = 0;
mock.module("../../native", () => ({
  ...native,
  NativeCapture: class {
    async start() {
      starts++;
      if (fail) throw Error("Startup failed");
      await startCapture();
    }
    async stop() {
      stops++;
    }
    async screenSize() {
      return { width: 2007, height: 2853, screenId: 3, orientation: "portrait" };
    }
    async activeScreenId() {
      return await readDisplay();
    }
    async updateStreamSettings() {
      await updateSettings();
    }
    async subscribeScreenChanges() {
      subscriptions++;
      return async () => {};
    }
    async subscribeDeviceState() {
      return async () => {};
    }
  },
  NativeHid: class {
    async setScreen() {}
    async supportsHingeAngle() {
      return false;
    }
    async supportsPhysicalOrientation() {
      return false;
    }
    async key() {}
    async close() {}
  },
}));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
const temp = useTempStateDir();
const { getDeviceSession, peekDeviceSession, closeDeviceSession, withScreenshotDeviceSession } =
  await import("../../device-session");
afterAll(() => {
  closeDeviceSession(UDID);
  temp.restore();
});
async function stopped(count: number) {
  for (let i = 0; i < 100 && stops < count; i++) await Bun.sleep(5);
  expect(stops).toBe(count);
}
test("a one-shot capture closes its temporary session on success and failure", async () => {
  expect(await withScreenshotDeviceSession(UDID, undefined, (s) => s.activeScreenId())).toBe(3);
  expect(peekDeviceSession(UDID)).toBeUndefined();
  await stopped(1);
  await expect(
    withScreenshotDeviceSession(UDID, undefined, async () => {
      throw Error("Capture failed");
    }),
  ).rejects.toThrow("Capture failed");
  await stopped(2);
  fail = true;
  await expect(
    withScreenshotDeviceSession(UDID, undefined, (s) => s.activeScreenId()),
  ).rejects.toThrow("Startup failed");
  fail = false;
  await stopped(3);
});
test("a screenshot borrows an existing session without closing or replacing it", async () => {
  const existing = getDeviceSession(UDID);
  await existing.start();
  const before = starts;
  expect(await withScreenshotDeviceSession(UDID, undefined, (s) => s.activeScreenId())).toBe(3);
  expect(peekDeviceSession(UDID)).toBe(existing);
  expect(starts).toBe(before);
  expect(stops).toBe(3);
  closeDeviceSession(UDID);
  await stopped(4);
});

test("overlapping screenshots share startup and a newly joined stream retains capture", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const before = starts,
    beforeStops = stops;
  const first = withScreenshotDeviceSession(UDID, undefined, async () => {
    entered();
    await gate;
  });
  await ready;
  const shared = peekDeviceSession(UDID)!;
  expect(await withScreenshotDeviceSession(UDID, undefined, (s) => s.activeScreenId())).toBe(3);
  expect(starts).toBe(before + 1);
  expect(stops).toBe(beforeStops);
  expect(getDeviceSession(UDID)).toBe(shared);
  release();
  await first;
  expect(peekDeviceSession(UDID)).toBe(shared);
  expect(stops).toBe(beforeStops);
  closeDeviceSession(UDID);
  await stopped(beforeStops + 1);
});

test("unknown and health helper requests do not retain temporary screenshot capture", async () => {
  const { simMiddleware } = await import("../../middleware");
  const middleware = simMiddleware({ basePath: "/sim" });
  for (const path of ["unknown", "health", "config"]) {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const beforeStops = stops;
    const shot = withScreenshotDeviceSession(UDID, undefined, async () => {
      entered();
      await gate;
    });
    await ready;
    await middleware(new Request(`http://localhost/sim/helper/${UDID}/${path}`));
    release();
    await shot;
    await stopped(beforeStops + 1);
    expect(peekDeviceSession(UDID)).toBeUndefined();
  }
  await middleware.dispose();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("recording cancellation survives screenshot session cleanup", async () => {
  const { simMiddleware } = await import("../../middleware");
  const middleware = simMiddleware({ basePath: "/sim" });
  const entered = deferred(),
    release = deferred();
  const beforeStops = stops;
  const shot = withScreenshotDeviceSession(UDID, undefined, async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const url = `http://localhost/sim/helper/${UDID}/recording/video`;
    const cancelled = await middleware(
      new Request(url, {
        method: "DELETE",
        headers: { "x-recording-id": "screenshot-cancellation" },
      }),
    );
    expect(cancelled?.status).toBe(202);
    release.resolve();
    await shot;
    await stopped(beforeStops + 1);
    expect(peekDeviceSession(UDID)).toBeUndefined();
    const started = await middleware(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: true,
          output: "/tmp/cancelled-recording",
          recordingId: "screenshot-cancellation",
        }),
      }),
    );
    expect(started?.status).toBe(409);
    expect(await started!.json()).toMatchObject({ error: "recording_start_cancelled" });
  } finally {
    release.resolve();
    await shot;
    closeDeviceSession(UDID);
    await middleware.dispose();
  }
});

test("an in-flight settings PATCH survives screenshot cleanup and retains accepted settings", async () => {
  const { simMiddleware } = await import("../../middleware");
  const middleware = simMiddleware({ basePath: "/sim" });
  const entered = deferred(),
    release = deferred(),
    updating = deferred(),
    updated = deferred();
  updateSettings = async () => {
    updating.resolve();
    await updated.promise;
  };
  const shot = withScreenshotDeviceSession(UDID, undefined, async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const session = peekDeviceSession(UDID);
    const url = `http://localhost/sim/helper/${UDID}/stream-settings`;
    const patch = middleware(
      new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDimension: 720 }),
      }),
    );
    await updating.promise;
    release.resolve();
    await shot;
    expect(peekDeviceSession(UDID)).toBe(session);
    updated.resolve();
    expect((await patch)?.status).toBe(200);
    expect(peekDeviceSession(UDID)).toBe(session);
    const settings = await middleware(new Request(url));
    expect(await settings!.json()).toMatchObject({ maxDimension: 720 });
  } finally {
    updated.resolve();
    release.resolve();
    await shot;
    updateSettings = async () => {};
    closeDeviceSession(UDID);
    await middleware.dispose();
  }
});

test("an invalid settings PATCH does not retain screenshot capture", async () => {
  const { simMiddleware } = await import("../../middleware");
  const middleware = simMiddleware({ basePath: "/sim" });
  const entered = deferred(),
    release = deferred();
  const beforeStops = stops;
  const shot = withScreenshotDeviceSession(UDID, undefined, async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const patch = await middleware(
      new Request(`http://localhost/sim/helper/${UDID}/stream-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDimension: "wrong" }),
      }),
    );
    expect(patch?.status).toBe(400);
    release.resolve();
    await shot;
    await stopped(beforeStops + 1);
    expect(peekDeviceSession(UDID)).toBeUndefined();
  } finally {
    release.resolve();
    await shot;
    await middleware.dispose();
  }
});

test("an aborted settings body never reports an accepted update despite default HTTP 200", async () => {
  const { IncomingMessage, ServerResponse } = await import("node:http");
  const { Socket } = await import("node:net");
  await withScreenshotDeviceSession(UDID, undefined, async (session) => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = "PATCH";
    req.headers = { "content-type": "application/json" };
    const res = new ServerResponse(req);
    res.destroy();
    const pending = session.handleStreamSettings(req, res);
    req.emit("aborted");
    expect(res.statusCode).toBe(200);
    expect(await pending).toBe(false);
    socket.destroy();
  });
  expect(peekDeviceSession(UDID)).toBeUndefined();
});

test("lowercase stream and uppercase screenshot share one session", async () => {
  const before = starts;
  const existing = getDeviceSession(UDID.toLowerCase());
  try {
    await existing.start();
    expect(await withScreenshotDeviceSession(UDID, undefined, (s) => s.activeScreenId())).toBe(3);
    expect(peekDeviceSession(UDID)).toBe(existing);
    expect(starts).toBe(before + 1);
  } finally {
    closeDeviceSession(UDID);
    closeDeviceSession(UDID.toLowerCase());
  }
});

async function deadlineResult() {
  return await Promise.race([
    withScreenshotDeviceSession(UDID, undefined, (s) => s.activeScreenId()).then(
      () => "success",
      (e: Error) => e.message,
    ),
    Bun.sleep(300).then(() => "unbounded"),
  ]);
}

test("a native startup deadline releases capture before startup settles", async () => {
  const gate = deferred();
  startCapture = () => gate.promise;
  const beforeStops = stops;
  const beforeSubscriptions = subscriptions;
  try {
    await withActionTimeoutAsync(30, async () => {
      expect(await deadlineResult()).toContain("did not finish");
      expect(peekDeviceSession(UDID)).toBeUndefined();
      await stopped(beforeStops + 1);
    });
  } finally {
    gate.resolve();
    startCapture = async () => {};
    await Bun.sleep(20);
    closeDeviceSession(UDID);
  }
  expect(subscriptions).toBe(beforeSubscriptions);
});

test("a native read deadline closes temporary capture and ignores late results", async () => {
  const gate = deferred();
  const beforeStops = stops;
  readDisplay = async () => {
    await gate.promise;
    return 3;
  };
  try {
    await withActionTimeoutAsync(30, async () => {
      expect(await deadlineResult()).toContain("did not finish");
      expect(peekDeviceSession(UDID)).toBeUndefined();
      await stopped(beforeStops + 1);
    });
  } finally {
    gate.resolve();
    readDisplay = async () => 3;
    await Bun.sleep(20);
    closeDeviceSession(UDID);
  }
});

test("a native read deadline leaves a retained viewer session running", async () => {
  const existing = getDeviceSession(UDID);
  await existing.start();
  const gate = deferred();
  const beforeStops = stops;
  readDisplay = async () => {
    await gate.promise;
    return 3;
  };
  try {
    await withActionTimeoutAsync(30, async () => {
      expect(await deadlineResult()).toContain("did not finish");
      expect(peekDeviceSession(UDID)).toBe(existing);
      expect(stops).toBe(beforeStops);
    });
  } finally {
    gate.resolve();
    readDisplay = async () => 3;
    await Bun.sleep(20);
    closeDeviceSession(UDID);
  }
});
