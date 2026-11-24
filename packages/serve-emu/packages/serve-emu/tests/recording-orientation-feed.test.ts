import { expect, test } from "bun:test";
import {
  startRecordingOrientationFeed,
  type OrientationReading,
} from "../src/recording-orientation-feed.ts";
import type { ScreenOrientation } from "../src/shared/api-contracts.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A screen whose reads the test can hold, and an event stream that it can push and end. */
function fakeDevice() {
  let shown: ScreenOrientation = "portrait";
  let settling = false;
  let held: (() => void) | null = null;
  let holdNext = false;
  let failNext = false;
  let reads = 0;
  let opens = 0;
  let change: (() => void) | null = null;
  let endStream: (() => void) | null = null;
  let streamSignal: AbortSignal | null = null;
  return {
    read: async (): Promise<OrientationReading> => {
      reads++;
      // The pose that the screen had when the read started.
      const atStart = { orientation: shown, settling };
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => (held = resolve));
      }
      if (failNext) {
        failNext = false;
        throw new Error("adb is busy");
      }
      return atStart;
    },
    watchChanges: (onChange: () => void, signal: AbortSignal) => {
      opens++;
      change = onChange;
      streamSignal = signal;
      return new Promise<void>((resolve) => {
        endStream = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    turn: (pose: ScreenOrientation, turning = false) => {
      shown = pose;
      settling = turning;
    },
    holdNextRead: () => {
      holdNext = true;
    },
    releaseRead: () => held?.(),
    failNextRead: () => {
      failNext = true;
    },
    pushChange: () => change?.(),
    endStream: () => endStream?.(),
    get reads() {
      return reads;
    },
    get opens() {
      return opens;
    },
    get streamAborted() {
      return streamSignal?.aborted ?? false;
    },
  };
}

function feedFor(
  device: ReturnType<typeof fakeDevice>,
  timing: { readIntervalMs?: number; settlingIntervalMs?: number; retryMs?: number } = {},
) {
  const observed: ScreenOrientation[] = [];
  let active = true;
  const feed = startRecordingOrientationFeed({
    read: device.read,
    watchChanges: device.watchChanges,
    observe: (orientation) => observed.push(orientation),
    active: () => active,
    ...timing,
  });
  return {
    feed,
    observed,
    end: () => {
      active = false;
    },
  };
}

test("reads the display at once, and again at once after a configuration change", async () => {
  const device = fakeDevice();
  const { feed, observed } = feedFor(device);
  await wait(5);
  expect(observed).toEqual(["portrait"]);
  // An app turns to landscape on its own; the device reports a configuration change.
  device.turn("landscape_left");
  device.pushChange();
  await wait(5);
  expect(observed).toEqual(["portrait", "landscape_left"]);
  expect(device.reads).toBe(2);
  feed.stop();
});

test("reads again when a change comes during a read that started before the turn", async () => {
  const device = fakeDevice();
  const { feed, observed } = feedFor(device);
  await wait(5);
  device.holdNextRead();
  feed.readNow();
  await wait(5);
  // The display turns while the read is in flight; that read reports the pose before the turn.
  device.turn("landscape_right");
  device.pushChange();
  device.pushChange();
  expect(device.reads).toBe(2);
  device.releaseRead();
  await wait(5);
  // One more read, not one per change.
  expect(device.reads).toBe(3);
  expect(observed).toEqual(["portrait", "portrait", "landscape_right"]);
  feed.stop();
});

test("reads only the display after a rotation request, so a refused lock changes nothing", async () => {
  const device = fakeDevice();
  const { feed, observed } = feedFor(device);
  await wait(5);
  // A Hub rotation on the launcher: the lock succeeds, but the display stays in portrait.
  feed.readNow();
  await wait(5);
  expect(observed).toEqual(["portrait", "portrait"]);
  feed.stop();
});

test("reads each interval without changes, and keeps going after a failed read", async () => {
  const device = fakeDevice();
  const { feed, observed } = feedFor(device, { readIntervalMs: 20 });
  await wait(5);
  device.failNextRead();
  await wait(30);
  // The failed read reported nothing; the timer read again.
  device.turn("portrait_upside_down");
  await wait(30);
  expect(observed[0]).toBe("portrait");
  expect(observed.at(-1)).toBe("portrait_upside_down");
  expect(device.reads).toBeGreaterThanOrEqual(3);
  feed.stop();
});

test("reads at the settling interval while an app is turned before the display", async () => {
  const device = fakeDevice();
  const { feed, observed } = feedFor(device, { readIntervalMs: 1_000, settlingIntervalMs: 10 });
  await wait(5);
  // An app opens turned while the display still has its old rotation.
  device.turn("landscape_left", true);
  device.pushChange();
  await wait(5);
  expect(observed.at(-1)).toBe("landscape_left");
  // Android cancels the turn without a display rotation, and logs no event for it.
  device.turn("portrait");
  await wait(30);
  expect(observed.at(-1)).toBe("portrait");
  const reads = device.reads;
  // Back to the one-second interval once nothing is turned.
  await wait(50);
  expect(device.reads).toBe(reads);
  feed.stop();
});

test("opens the change stream again after it ends", async () => {
  const device = fakeDevice();
  const { feed, observed } = feedFor(device, { retryMs: 10 });
  await wait(5);
  expect(device.opens).toBe(1);
  device.endStream();
  await wait(30);
  expect(device.opens).toBe(2);
  device.turn("landscape_left");
  device.pushChange();
  await wait(5);
  expect(observed.at(-1)).toBe("landscape_left");
  feed.stop();
});

test("stops when the recording ends, with its change stream", async () => {
  const device = fakeDevice();
  const { observed, end } = feedFor(device, { readIntervalMs: 10 });
  await wait(5);
  end();
  await wait(30);
  // The next timer read saw the end, stopped the feed and aborted the stream.
  expect(device.streamAborted).toBe(true);
  const reads = device.reads;
  device.turn("landscape_left");
  device.pushChange();
  await wait(30);
  expect(device.reads).toBe(reads);
  expect(observed).toEqual(["portrait"]);
});
