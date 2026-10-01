import { expect, mock, test } from "bun:test";
import {
  PLAYBACK_STALL_POLLS,
  PLAYBACK_STALL_POLL_MS,
} from "../../webrtc-playback-stall.js";

let effects: (() => void | (() => void))[] = [];
let updates: unknown[] = [];
let pendingStats: { resolve: (value: Map<string, unknown>) => void }[] = [];
let peers: FakePeer[] = [];
let closed = 0;
let visibility: "visible" | "hidden" = "visible";
let visibilityListener: (() => void) | undefined;
let nextTimer = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();
let nextInterval = 0;
const intervals = new Map<number, () => void>();
const POLL_MS = PLAYBACK_STALL_POLL_MS;
let clock = 0;
/// What the signalling endpoint answers the offer with.
let offerStatus = 200;
let offersPosted = 0;
let offerBody = "nope";

class FakePeer {
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "v=0" };
  onconnectionstatechange?: () => void;
  ontrack?: (event: { track: object; streams: object[] }) => void;
  constructor() { peers.push(this); }
  addTransceiver() { return {}; }
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  getStats() {
    return new Promise<Map<string, unknown>>((resolve) => pendingStats.push({ resolve }));
  }
  close() { closed += 1; }
}

mock.module("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, (update: unknown) => updates.push(update)],
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));

function fakeSetTimeout(callback: () => void, delay = 0) {
  timers.set(++nextTimer, { callback, delay });
  return nextTimer;
}
function fakeClearTimeout(id: number) {
  timers.delete(id);
}

function fakeSetInterval(callback: () => void) {
  intervals.set(++nextInterval, callback);
  return nextInterval;
}
function fakeClearInterval(id: number) {
  intervals.delete(id);
}

Object.assign(globalThis, {
  // `startExclusivePoll` and the signalling busy loop reach for the global timers.
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  document: {
    get hidden() { return visibility === "hidden"; },
    get visibilityState() { return visibility; },
    addEventListener(name: string, listener: () => void) {
      if (name === "visibilitychange") visibilityListener = listener;
    },
    removeEventListener(name: string, listener: () => void) {
      if (name === "visibilitychange" && visibilityListener === listener) visibilityListener = undefined;
    },
  },
  window: {
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  // Controlled clock: the gap guard and the read deadline are both wall-clock decisions, and
  // a real `performance.now()` advances ~1ms per tick here, so neither would ever be reached.
  performance: { now: () => clock },
  Date: Object.assign(Date, { now: () => clock }),
  RTCPeerConnection: FakePeer,
  RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
  MediaStream: class {},
  fetch: async (input: string) => {
    if (input.includes("/stats")) {
      return new Response(JSON.stringify({ sessions: [{ framesEncoded: 0 }] }));
    }
    if (input.includes("/offer")) offersPosted += 1;
    if (input.includes("/offer") && offerStatus !== 200) {
      return new Response(offerBody, { status: offerStatus });
    }
    return new Response(JSON.stringify({ type: "answer", sdp: "" }));
  },
});

// Import after mocking React and the browser surface so this exercises the real hook.
const { useWebRtcStream } = await import("../../useWebRtcStream.js");
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
let cleanup: (void | (() => void))[] = [];

/// Options a test passes to the hook on top of the defaults. Reset by every `start`.
let hookOptions: { allowCodecFallback?: boolean } = {};

async function start(
  visible: "visible" | "hidden" = "visible",
  offerAnswers = 200,
  transportLocked = true,
) {
  cleanup.forEach((stop) => stop?.());
  effects = [];
  updates = [];
  pendingStats = [];
  peers = [];
  closed = 0;
  visibility = visible;
  offerStatus = offerAnswers;
  offersPosted = 0;
  offerBody = "nope";
  clock = 0;
  timers.clear();
  intervals.clear();
  const hook = useWebRtcStream({
    offerUrl: "http://local/offer",
    closeUrl: "http://local/close",
    statsUrl: "http://local/stats",
    enabled: true,
    codec: "h264",
    transportLocked,
    ...hookOptions,
  });
  hookOptions = {};
  cleanup = effects.map((effect) => effect());
  await flush();
  peers[0]?.ontrack?.({ track: {}, streams: [{}] });
  peers[0]?.onconnectionstatechange?.();
  return hook;
}

/// What `retryTransport` causes: a new `retryGeneration` re-runs the stream effect while the
/// component stays mounted, so every ref survives. Re-running it alone models that; calling
/// the hook again would be a remount and would hand back fresh refs.
async function reconnect() {
  cleanup[2]?.();
  pendingStats = [];
  peers = [];
  cleanup[2] = effects[2]!();
  await flush();
  peers[0]?.ontrack?.({ track: {}, streams: [{}] });
  peers[0]?.onconnectionstatechange?.();
}

function resolveStats(framesReceived: number, framesDecoded = framesReceived, id = "video") {
  const read = pendingStats.shift();
  if (!read) throw new Error("Expected an inbound stats read");
  read.resolve(new Map([[id, {
    id,
    type: "inbound-rtp",
    kind: "video",
    framesReceived,
    framesDecoded,
  }]]));
}

/// Drive the stall watchdog with one sample per poll, advancing the clock like a real timer.
/// `gapMs` fakes a sleep between two polls without raising visibilitychange.
async function pollStall(
  samples: { received: number; decoded: number; id?: string }[],
  gapMs = POLL_MS,
) {
  for (const sample of samples) {
    clock += gapMs;
    for (const tick of intervals.values()) tick();
    await flush();
    if (pendingStats.length > 0) resolveStats(sample.received, sample.decoded, sample.id);
    await flush();
  }
}

/// One more sample than the threshold needs, so the run reaches a verdict.
function frozenRun(decoded: number, from = decoded) {
  return Array.from({ length: PLAYBACK_STALL_POLLS + 1 }, (_, i) => ({
    received: from + i * 100,
    decoded,
  }));
}

/// Nothing arriving at all: the path is dead, not the decoder.
function deadRun(at: number) {
  return Array.from({ length: PLAYBACK_STALL_POLLS + 1 }, () => ({ received: at, decoded: at }));
}

const STALLED = "WebRTC playback stalled. Retrying...";

function failures() {
  return updates.filter((value): value is { kind: string } =>
    typeof value === "object" && value !== null && "kind" in value);
}

test("the first stall reconnects on the same codec", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
});


test("a stall with no media arriving is charged to the transport", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(deadRun(100));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
});

test("a decoder that catches up never reports a stall", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall([
    { received: 100, decoded: 100 },
    { received: 200, decoded: 100 },
    { received: 300, decoded: 100 },
    { received: 400, decoded: 220 },
    { received: 500, decoded: 320 },
    { received: 600, decoded: 420 },
  ]);
  expect(failures()).toEqual([]);
  expect(updates).not.toContain(STALLED);
});

test("a long gap between polls ends the run even with no visibility event", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100).slice(0, PLAYBACK_STALL_POLLS));
  await pollStall([{ received: 400, decoded: 100 }], 20 * 60_000);
  await pollStall([
    { received: 500, decoded: 100 },
    { received: 600, decoded: 100 },
  ]);
  expect(updates).not.toContain(STALLED);
});

test("a hidden tab never trips the stall watchdog", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  visibility = "hidden";
  visibilityListener?.();
  for (let i = 0; i < 8; i++) {
    for (const tick of intervals.values()) tick();
    await flush();
  }
  expect(pendingStats).toHaveLength(0);
  expect(failures()).toEqual([]);
});


test("a repeated decoder stall demotes only after a same-codec reconnect", async () => {
  const hook = await start(); hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
  await reconnect(); hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toMatchObject([{ kind: "codec", codec: "h264" }]);
});

test("Android retries its transport instead of walking the iOS codec ladder", async () => {
  hookOptions = { allowCodecFallback: false };
  const hook = await start(); hook.markFrameDecoded();
  await pollStall(frozenRun(100)); await reconnect(); hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
});

test("stats subscribers share the watchdog's single read", async () => {
  const hook = await start(); hook.markFrameDecoded();
  const reports: number[] = [];
  const unsubscribe = hook.subscribeStats((report) => reports.push(report.size));
  await pollStall([{received: 100, decoded: 100}]);
  expect(reports).toEqual([1]); expect(pendingStats).toHaveLength(0);
  unsubscribe(); await pollStall([{received: 200, decoded: 200}]);
  expect(reports).toEqual([1]);
});

cleanup.forEach((stop) => stop?.());
