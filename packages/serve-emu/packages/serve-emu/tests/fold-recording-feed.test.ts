import { expect, test } from "bun:test";
import type { HingeSensor } from "../src/fold.ts";
import { startFoldRecordingFeed } from "../src/fold-recording-feed.ts";
import type { RecordingPose } from "../src/recording-canvas.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSensor() {
  let angle = 180;
  let failing = false;
  let reads = 0;
  let closed = false;
  let push: (() => void) | null = null;
  let watchSignal: AbortSignal | null = null;
  const sensor: HingeSensor = {
    readAngle: async () => {
      reads++;
      if (failing) throw new Error("gRPC unavailable");
      return angle;
    },
    watchPostures: (onChange, signal) => {
      push = onChange;
      watchSignal = signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
    },
    close: () => {
      closed = true;
    },
  };
  return {
    sensor,
    setAngle: (value: number) => {
      angle = value;
    },
    fail: () => {
      failing = true;
    },
    push: () => push?.(),
    get reads() {
      return reads;
    },
    get closed() {
      return closed;
    },
    get watchAborted() {
      return watchSignal?.aborted ?? false;
    },
  };
}

function feedWith(
  open: (signal: AbortSignal) => Promise<HingeSensor>,
  adbAngle: () => number | null = () => 45,
) {
  const observed: RecordingPose[] = [];
  let active = true;
  let adbReads = 0;
  const feed = startFoldRecordingFeed({
    openSensor: open,
    readHingeOverAdb: async () => {
      adbReads++;
      return adbAngle();
    },
    observe: (pose) => observed.push(pose),
    active: () => active,
  });
  return {
    feed,
    observed,
    end: () => {
      active = false;
    },
    get adbReads() {
      return adbReads;
    },
  };
}

test("reads the hinge over gRPC every 100 ms, and at once on a push", async () => {
  const fake = fakeSensor();
  const { feed, observed } = feedWith(async () => fake.sensor);
  await wait(30);
  // The first read went over adb, before the sensor opened; the next one over gRPC. The
  // orientation feed reads the orientation apart from the hinge.
  expect(observed.slice(0, 2)).toEqual([{ hingeAngle: 45 }, { hingeAngle: 180 }]);
  await wait(320);
  // About three more gRPC reads, one each 100 ms, not one each second.
  expect(fake.reads).toBeGreaterThanOrEqual(2);
  expect(fake.reads).toBeLessThanOrEqual(6);
  fake.setAngle(90);
  const before = fake.reads;
  fake.push();
  await wait(5);
  expect(fake.reads).toBe(before + 1);
  expect(observed.at(-1)).toEqual({ hingeAngle: 90 });
  feed.stop();
  expect(fake.closed).toBe(true);
  expect(fake.watchAborted).toBe(true);
  const count = observed.length;
  await wait(150);
  expect(observed).toHaveLength(count);
});

test("falls back to adb once a gRPC read fails, and reads it each second", async () => {
  const fake = fakeSensor();
  const state = feedWith(async () => fake.sensor);
  await wait(30);
  fake.fail();
  await wait(120);
  expect(fake.closed).toBe(true);
  const adbReads = state.adbReads;
  await wait(300);
  // No gRPC read after the failure, and no adb read before the next second.
  expect(state.adbReads).toBe(adbReads);
  expect(state.observed.at(-1)).toEqual({ hingeAngle: 45 });
  state.feed.stop();
});

test("reads over adb when the sensor does not open, and reports no unknown angle", async () => {
  const state = feedWith(
    async () => {
      throw new Error("no gRPC endpoint");
    },
    () => null,
  );
  await wait(30);
  expect(state.adbReads).toBe(1);
  expect(state.observed).toEqual([]);
  state.feed.stop();
});

test("stops when the recording ends, and closes a sensor that opens after a stop", async () => {
  const fake = fakeSensor();
  let open!: (sensor: HingeSensor) => void;
  const state = feedWith(() => new Promise((resolve) => (open = resolve)));
  await wait(10);
  state.feed.stop();
  open(fake.sensor);
  await wait(10);
  expect(fake.closed).toBe(true);
  expect(fake.reads).toBe(0);

  const second = fakeSensor();
  const ending = feedWith(async () => second.sensor);
  await wait(30);
  ending.end();
  const reads = second.reads;
  await wait(250);
  expect(second.reads).toBe(reads);
  // The end of the recording closes the sensor and its posture stream without a stop().
  expect(second.closed).toBe(true);
  expect(second.watchAborted).toBe(true);
});

test("a recording that ends before the sensor opens closes the sensor when it opens", async () => {
  const fake = fakeSensor();
  let open!: (sensor: HingeSensor) => void;
  const state = feedWith(() => new Promise((resolve) => (open = resolve)));
  await wait(10);
  state.end();
  await wait(1_100);
  open(fake.sensor);
  await wait(10);
  expect(fake.closed).toBe(true);
  expect(fake.reads).toBe(0);
});
