import { expect, test } from "bun:test";
import { createServer } from "http";
import { DeviceSession, finishDeviceRecordingsForShutdown } from "../../device-session";
import { useTempStateDir } from "../helpers";

test("recording start rejects control characters in its ID before capture", async () => {
  const session = new DeviceSession("recording-invalid-id-test");
  const target = session as any;
  target.phase = "running";
  target.captureStart = Promise.resolve();
  let starts = 0;
  target.capture = {
    startRecording: async () => { starts++; },
    stop: async () => {},
  };
  const server = createServer((req, res) => { void session.handleVideoRecording(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  try {
    for (const recordingId of ["bad\nidentifier", "bad-id\n"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/recording/video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: true, output: "/tmp/invalid-id", recordingId }),
      });
      expect(response.status).toBe(400);
    }
    expect(starts).toBe(0);
  } finally {
    server.close();
    session.close();
  }
});

test("a DELETE during startup cancels the eventual recording", async () => {
  const state = useTempStateDir();
  const session = new DeviceSession("recording-lifecycle-test");
  const target = session as any;
  target.phase = "running";
  target.captureStart = Promise.resolve();
  let finishStart: () => void = () => {};
  const startGate = new Promise<void>(resolve => { finishStart = resolve; });
  let started = 0;
  let stopped = 0;
  target.capture = {
    startRecording: async () => { started++; await startGate; },
    stopRecording: async () => { stopped++; return "/tmp/cancelled/session.json"; },
    stop: async () => {},
  };
  const server = createServer((req, res) => { void session.handleVideoRecording(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  const url = `http://127.0.0.1:${address.port}/recording/video`;
  try {
    const start = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: true, output: "/tmp/cancelled", recordingId: "lease-a" }),
    });
    for (let i = 0; i < 100 && started === 0; i++) await Bun.sleep(5);
    expect(started).toBe(1);
    const cancel = fetch(url, { method: "DELETE", headers: { "x-recording-id": "lease-a" } });
    for (let i = 0; i < 100 && !target.recordingStartCancelled; i++) await Bun.sleep(5);
    expect(target.recordingStartCancelled).toBe(true);
    finishStart();
    expect(await (await cancel).json()).toEqual({ manifest: "/tmp/cancelled/session.json" });
    expect((await start).ok).toBe(false);
    const retry = await fetch(url, { method: "DELETE", headers: { "x-recording-id": "lease-a" } });
    expect(await retry.json()).toEqual({ manifest: "/tmp/cancelled/session.json" });
    expect(stopped).toBe(1);
    expect(target.recordingLease).toBeUndefined();
  } finally {
    finishStart();
    server.close();
    session.close();
    state.restore();
  }
});

test("a DELETE before capture starts prevents recording startup", async () => {
  const session = new DeviceSession("recording-early-cancel-test");
  const target = session as any;
  target.phase = "running";
  let finishCapture: () => void = () => {};
  target.captureStart = new Promise<void>(resolve => { finishCapture = resolve; });
  let starts = 0;
  target.capture = {
    startRecording: async () => { starts++; },
    stopRecording: async () => "/tmp/early-cancel/session.json",
    stop: async () => {},
  };
  const server = createServer((req, res) => { void session.handleVideoRecording(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  const url = `http://127.0.0.1:${address.port}/recording/video`;
  try {
    const start = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: true, output: "/tmp/early-cancel", recordingId: "lease-early" }),
    });
    for (let i = 0; i < 100 && !target.recordingStarting; i++) await Bun.sleep(5);
    expect(target.recordingStarting).toBe(true);
    const cancel = fetch(url, { method: "DELETE", headers: { "x-recording-id": "lease-early" } });
    for (let i = 0; i < 100 && !target.recordingStartCancelled; i++) await Bun.sleep(5);
    expect(target.recordingStartCancelled).toBe(true);
    finishCapture();
    expect((await cancel).status).toBe(202);
    expect((await start).ok).toBe(false);
    expect(starts).toBe(0);
  } finally {
    finishCapture();
    server.close();
    session.close();
  }
});

test("a DELETE arriving before POST prevents a late recording start", async () => {
  const session = new DeviceSession("recording-reordered-cancel-test");
  const target = session as any;
  target.phase = "running";
  target.captureStart = Promise.resolve();
  let starts = 0;
  target.capture = { startRecording: async () => { starts++; }, stop: async () => {} };
  const server = createServer((req, res) => { void session.handleVideoRecording(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  const url = `http://127.0.0.1:${address.port}/recording/video`;
  try {
    const cancel = await fetch(url, { method: "DELETE", headers: { "x-recording-id": "late-start" } });
    expect(cancel.status).toBe(202);
    const start = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: true, output: "/tmp/reordered", recordingId: "late-start" }),
    });
    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({ error: "recording_start_cancelled" });
    expect(starts).toBe(0);
  } finally {
    server.close();
    session.close();
  }
});

test("duplicate DELETE waits for the same finalization and replays its manifest", async () => {
  const session = new DeviceSession("recording-stop-retry-test");
  const target = session as any;
  target.phase = "running";
  let finishStop: () => void = () => {};
  const stopGate = new Promise<void>(resolve => { finishStop = resolve; });
  let stops = 0;
  target.capture = {
    stopRecording: async () => { stops++; await stopGate; return "/tmp/retry/session.json"; },
    stop: async () => {},
  };
  target.refreshRecordingLease("retry-id");
  const server = createServer((req, res) => { void session.handleVideoRecording(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  const url = `http://127.0.0.1:${address.port}/recording/video`;
  const stop = () => fetch(url, { method: "DELETE", headers: { "x-recording-id": "retry-id" } });
  try {
    const first = stop();
    for (let i = 0; i < 100 && stops === 0; i++) await Bun.sleep(5);
    expect(stops).toBe(1);
    const second = stop();
    finishStop();
    expect(await (await first).json()).toEqual({ manifest: "/tmp/retry/session.json" });
    expect(await (await second).json()).toEqual({ manifest: "/tmp/retry/session.json" });
    expect(await (await stop()).json()).toEqual({ manifest: "/tmp/retry/session.json" });
    expect(stops).toBe(1);
  } finally {
    finishStop();
    server.close();
    session.close();
  }
});

test("a DELETE retry keeps a finalization failure visible", async () => {
  const session = new DeviceSession("recording-stop-failure-retry-test");
  const target = session as any;
  target.phase = "running";
  target.capture = {
    stopRecording: async () => { throw new Error("MP4 finalization failed"); },
    stop: async () => {},
  };
  target.refreshRecordingLease("failed-id");
  const server = createServer((req, res) => { void session.handleVideoRecording(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  const url = `http://127.0.0.1:${address.port}/recording/video`;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, { method: "DELETE", headers: { "x-recording-id": "failed-id" } });
      expect(response.status).toBe(500);
      expect((await response.json()).message).toContain("MP4 finalization failed");
    }
  } finally {
    server.close();
    session.close();
  }
});

test("shutdown shares an in-progress recording stop", async () => {
  const session = new DeviceSession("recording-overlap-test");
  const target = session as any;
  target.phase = "running";
  let finishStop: () => void = () => {};
  const stopGate = new Promise<void>(resolve => { finishStop = resolve; });
  let stops = 0;
  target.capture = {
    stopRecording: async () => { stops++; await stopGate; return "/tmp/overlap/session.json"; },
    stop: async () => {},
  };
  target.refreshRecordingLease("lease-overlap");
  const stopping = target.finishRecording("lease-overlap") as Promise<string>;
  const shutdown = session.finishRecordingForShutdown();
  expect(stops).toBe(1);
  finishStop();
  expect(await stopping).toBe("/tmp/overlap/session.json");
  await shutdown;
  expect(stops).toBe(1);
  session.close();
});

test("an expired lease finishes its recording", async () => {
  const session = new DeviceSession("recording-expiry-test");
  const target = session as any;
  target.phase = "running";
  target.recordingLeaseMs = 10;
  let stops = 0;
  target.capture = {
    stopRecording: async () => { stops++; return "/tmp/expired/session.json"; },
    stop: async () => {},
  };
  target.refreshRecordingLease("lease-expiry");
  for (let i = 0; i < 100 && stops === 0; i++) await Bun.sleep(5);
  expect(stops).toBe(1);
  expect(target.recordingLease).toBeUndefined();
  session.close();
});

test("a later successful recording does not erase an earlier finalization failure", async () => {
  const session = new DeviceSession("recording-prior-failure-test");
  const target = session as any;
  target.phase = "running";
  let stops = 0;
  let tornDown = false;
  target.capture = {
    stopRecording: async () => {
      if (++stops === 1) throw new Error("first MP4 finalization failed");
      return "/tmp/second/session.json";
    },
    stop: async () => { tornDown = true; },
  };
  target.refreshRecordingLease("first");
  await expect(target.finishRecording("first")).rejects.toThrow("first MP4 finalization failed");
  target.refreshRecordingLease("second");
  expect(await target.finishRecording("second")).toBe("/tmp/second/session.json");
  session.close();
  expect(await finishDeviceRecordingsForShutdown()).toBe(false);
  expect(stops).toBe(2);
  expect(tornDown).toBe(true);
});

test("shutdown reports finalization failure after a recording lease expires", async () => {
  const session = new DeviceSession("recording-expiry-failure-test");
  const target = session as any;
  target.phase = "running";
  target.recordingLeaseMs = 10;
  let tornDown = false;
  target.capture = {
    stopRecording: async () => { throw new Error("expired MP4 finalization failed"); },
    stop: async () => { tornDown = true; },
  };
  target.refreshRecordingLease("lease-expiry-failure");
  for (let i = 0; i < 100 && !target.recordingFailure; i++) await Bun.sleep(5);
  expect(String(target.recordingFailure)).toContain("expired MP4 finalization failed");
  session.close();
  expect(await finishDeviceRecordingsForShutdown()).toBe(false);
  expect(tornDown).toBe(true);
});

test("shutdown reports a failed finalization after closing during startup", async () => {
  const session = new DeviceSession("recording-start-close-failure-test");
  const target = session as any;
  target.phase = "running";
  let failStart: (error: Error) => void = () => {};
  target.recordingStart = new Promise<void>((_, reject) => { failStart = reject; });
  let tornDown = false;
  target.capture = { stop: async () => { tornDown = true; } };
  session.close();
  failStart(new Error("startup MP4 finalization failed"));
  expect(await finishDeviceRecordingsForShutdown()).toBe(false);
  expect(tornDown).toBe(true);
});

test("shutdown reports a closed session's recording stop failure", async () => {
  const session = new DeviceSession("recording-stop-failure-test");
  const target = session as any;
  target.phase = "running";
  target.capture.handle = { stop: async () => { throw new Error("MP4 finalization failed"); } };
  session.close();
  expect(await finishDeviceRecordingsForShutdown()).toBe(false);
});

test("shutdown reports an in-progress MP4 finalization failure after teardown", async () => {
  const session = new DeviceSession("recording-finalization-failure-test");
  const target = session as any;
  target.phase = "running";
  let failFinalization: () => void = () => {};
  const finalizationGate = new Promise<void>(resolve => { failFinalization = resolve; });
  let tornDown = false;
  target.capture = {
    stopRecording: async () => {
      await finalizationGate;
      throw new Error("MP4 finalization failed");
    },
    stop: async () => { tornDown = true; },
  };
  target.refreshRecordingLease("lease-failure");
  const stopping = target.finishRecording("lease-failure") as Promise<string>;
  session.close();
  failFinalization();
  await expect(stopping).rejects.toThrow("MP4 finalization failed");
  expect(await finishDeviceRecordingsForShutdown()).toBe(false);
  expect(tornDown).toBe(true);
});
