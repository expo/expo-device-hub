import { expect, mock, test } from "bun:test";
import {
  PLAYBACK_STALL_POLLS,
  PLAYBACK_STALL_POLL_MS,
} from "../../client/webrtc-playback-stall";

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

class FakePeer {
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "v=0" };
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

function fakeSetInterval(callback: () => void) {
  intervals.set(++nextInterval, callback);
  return nextInterval;
}
function fakeClearInterval(id: number) {
  intervals.delete(id);
}

Object.assign(globalThis, {
  // `startExclusivePoll` reaches for the global timer, not `window`'s.
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  document: {
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
    setTimeout(callback: () => void, delay: number) {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout(id: number) { timers.delete(id); },
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
  fetch: async (input: string) => new Response(JSON.stringify(
    input.includes("/stats")
      ? { sessions: [{ framesEncoded: 0 }] }
      : { type: "answer", sdp: "" },
  )),
});

// Import after mocking React and the browser surface so this exercises the real hook.
const { useWebRtcStream } = await import("../../client/hooks/use-webrtc-stream");
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
let cleanup: (void | (() => void))[] = [];

/// Options a test passes to the hook on top of the defaults. Reset by every `start`.
let hookOptions: { judgeStalls?: boolean } = {};

async function start(visible: "visible" | "hidden" = "visible") {
  cleanup.forEach((stop) => stop?.());
  effects = [];
  updates = [];
  pendingStats = [];
  peers = [];
  closed = 0;
  visibility = visible;
  clock = 0;
  timers.clear();
  intervals.clear();
  const hook = useWebRtcStream({
    offerUrl: "http://local/offer",
    closeUrl: "http://local/close",
    statsUrl: "http://local/stats",
    enabled: true,
    ...hookOptions,
  });
  hookOptions = {};
  cleanup = effects.map((effect) => effect());
  await flush();
  peers[0]?.ontrack?.({ track: {}, streams: [{}] });
  return hook;
}

/// What `retryTransport` causes: a new `retryGeneration` re-runs the stream effect while the
/// component stays mounted, so every ref survives. Re-running it alone models that; calling
/// the hook again would be a remount and would hand back fresh refs.
async function reconnect() {
  cleanup[1]?.();
  pendingStats = [];
  peers = [];
  cleanup[1] = effects[1]!();
  await flush();
  peers[0]?.ontrack?.({ track: {}, streams: [{}] });
}

function fireTimer() {
  const entry = timers.entries().next().value;
  if (!entry) throw new Error("Expected a watchdog timer");
  timers.delete(entry[0]);
  entry[1].callback();
  return entry[1].delay;
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

test("first-frame watchdog pauses while hidden and restarts on resume", async () => {
  const hook = await start("hidden");
  expect(timers.size).toBe(0);
  visibility = "visible";
  visibilityListener?.();
  expect(fireTimer()).toBe(4_000);
  await flush();
  resolveStats(10);
  await flush();
  visibility = "hidden";
  visibilityListener?.();
  expect(timers.size).toBe(0);
  expect(failures()).toEqual([]);
  visibility = "visible";
  visibilityListener?.();
  hook.markFrameDecoded();
  expect(timers.size).toBe(0);
  expect(failures()).toEqual([]);
});

test("first-frame decision uses connection state after getStats resolves", async () => {
  await start();
  expect(fireTimer()).toBe(4_000);
  await flush();
  peers[0]!.connectionState = "disconnected";
  resolveStats(0);
  await flush();
  expect(failures()).toEqual([]);
  expect(updates).toContain("WebRTC did not establish a video path. Retrying...");
});

test("a hung first-frame stats read reaches a finite failure decision", async () => {
  await start();
  expect(fireTimer()).toBe(4_000);
  await flush();
  expect(pendingStats).toHaveLength(1);
  expect(fireTimer()).toBe(4_000);
  await flush();
  expect(closed).toBe(1);
  expect(failures()).toMatchObject([{ kind: "codec" }]);
});

test("stall-timer ticks do not retire the first-frame watchdog", async () => {
  await start();
  expect(fireTimer()).toBe(4_000);
  await flush();
  expect(pendingStats).toHaveLength(1);
  // The read is in flight; the stall timer keeps ticking because nothing has painted yet.
  for (const tick of intervals.values()) { tick(); tick(); }
  await flush();
  resolveStats(0);
  await flush();
  expect(closed).toBe(1);
  expect(failures()).toMatchObject([{ kind: "codec" }]);
});

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

test("a run does not resume across a hide and show", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100).slice(0, PLAYBACK_STALL_POLLS));
  visibility = "hidden";
  visibilityListener?.();
  clock += 60_000;
  visibility = "visible";
  visibilityListener?.();
  // Enough to finish the pre-hide run, not enough to start a new one.
  await pollStall([
    { received: 400, decoded: 100 },
    { received: 500, decoded: 100 },
    { received: 600, decoded: 100 },
  ]);
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

/// A Duo keeps the hidden screen's stream running. Its decoder can freeze without the user
/// seeing it, and its verdict would fail the codec for the screen they are looking at.
test("a stream that may not judge stalls still feeds the panel but never calls one", async () => {
  hookOptions = { judgeStalls: false };
  const hook = await start();
  hook.markFrameDecoded();
  const seen: number[] = [];
  hook.subscribeStats((report) => seen.push(report.size));
  await pollStall(frozenRun(100));
  await pollStall(frozenRun(100, 5_000));
  expect(updates).not.toContain(STALLED);
  expect(failures()).toEqual([]);
  expect(seen.length).toBe(2 * (PLAYBACK_STALL_POLLS + 1));
});

/// The panel is what gets opened when the picture is black, which is before anything paints.
/// Gating its samples on a painted stream leaves it blank in exactly that case.
test("the panel is fed before the stream paints", async () => {
  const hook = await start();
  const seen: number[] = [];
  hook.subscribeStats((report) => seen.push(report.size));
  await pollStall([{ received: 0, decoded: 0 }, { received: 0, decoded: 0 }]);
  expect(seen).toEqual([1, 1]);
  expect(failures()).toEqual([]);
  expect(updates).not.toContain(STALLED);
});

/// The counters come back with the read, so the stamp has to be the arrival. Stamping the
/// call puts the read's own latency into the panel's rate divisor.
test("a sample is stamped when its read arrives, not when it was asked for", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  const stamps: number[] = [];
  hook.subscribeStats((_report, at) => stamps.push(at));
  clock += POLL_MS;
  for (const tick of intervals.values()) tick();
  await flush();
  const askedAt = clock;
  clock += 400;
  resolveStats(100, 100);
  await flush();
  expect(stamps).toEqual([askedAt + 400]);
});

/// The panel reads the watchdog's own report. Two pollers would leave a second read pending
/// on every tick, and would double the getStats load for one stream.
test("one stats read serves both the watchdog and the panel", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  const seen: number[] = [];
  const unsubscribe = hook.subscribeStats((report) => seen.push(report.size));
  await pollStall(frozenRun(100).slice(0, 3));
  expect(seen).toEqual([1, 1, 1]);
  expect(pendingStats).toHaveLength(0);

  unsubscribe();
  await pollStall([{ received: 400, decoded: 100 }]);
  expect(seen).toHaveLength(3);
});

/// A backgrounded tab does not always raise visibilitychange, so the poll checks for itself.
test("a run does not survive a brief hide with no visibility event", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100).slice(0, PLAYBACK_STALL_POLLS));
  visibility = "hidden";
  // Short enough that the gap guard would not catch it.
  await pollStall([{ received: 800, decoded: 100 }, { received: 800, decoded: 100 }]);
  expect(pendingStats).toHaveLength(0);
  visibility = "visible";
  await pollStall([
    { received: 900, decoded: 100 },
    { received: 1_000, decoded: 100 },
    { received: 1_100, decoded: 100 },
  ]);
  expect(updates).not.toContain(STALLED);
});

test("a stall run does not carry across a change of inbound report", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  // One poll short of a stall, then enough on a new report to cross it if the run carried.
  await pollStall(frozenRun(100).slice(0, PLAYBACK_STALL_POLLS));
  await pollStall([
    { received: 500, decoded: 100, id: "video-2" },
    { received: 600, decoded: 100, id: "video-2" },
  ]);
  expect(updates).not.toContain(STALLED);
});

test("a stats read that never resolves cannot produce a stall", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  for (let i = 0; i < PLAYBACK_STALL_POLLS * 2; i++) {
    clock += POLL_MS;
    for (const tick of intervals.values()) tick();
    await flush();
    // Nothing is resolved: every read is left hanging.
  }
  expect(failures()).toEqual([]);
  expect(updates).not.toContain(STALLED);
});

async function tick(advanceMs = POLL_MS) {
  clock += advanceMs;
  for (const fire of intervals.values()) fire();
  await flush();
}

/// Give up on the read in flight, as its decision deadline does.
async function expireReadDeadline() {
  for (const [id, timer] of timers) {
    if (timer.delay !== POLL_MS * 2) continue;
    timers.delete(id);
    timer.callback();
  }
  await flush();
}

/// `getStats` cannot be cancelled, so a deadline only stops the waiting. Asking again on every
/// poll would pile up one more hung read each time.
test("a hung read stays the only read until it settles", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  for (let i = 0; i < 4; i++) {
    await tick();
    await expireReadDeadline();
  }
  expect(pendingStats).toHaveLength(1);

  resolveStats(100, 100);
  await flush();
  await tick();
  expect(pendingStats).toHaveLength(1);
});

/// The panel's listeners outlive a reconnect, so a read the old peer finishes late would
/// otherwise open the new peer's history with the old one's counters.
test("a read that lands after its peer was replaced never reaches the panel", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  const seen: number[] = [];
  hook.subscribeStats((report) => seen.push(report.size));
  await tick();
  const late = pendingStats.shift()!;
  await reconnect();
  late.resolve(new Map([["video", { id: "video", type: "inbound-rtp", kind: "video", framesReceived: 900, framesDecoded: 900 }]]));
  await flush();
  expect(seen).toEqual([]);
});

test("ticks that overlap an unfinished read do not count twice", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  let received = 100;
  // Each measurement spans two ticks. One short of a stall, unless the skipped ticks count.
  for (let i = 0; i < PLAYBACK_STALL_POLLS - 1; i++) {
    await tick();
    await tick();
    received += 100;
    while (pendingStats.length > 0) {
      resolveStats(received, 100);
      await flush();
    }
  }
  expect(failures()).toEqual([]);
});

test("a jittery poll interval still reaches a stall", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  let received = 100;
  for (let i = 0; i < PLAYBACK_STALL_POLLS + 2; i++) {
    await tick(POLL_MS * 1.5);
    received += 100;
    if (pendingStats.length > 0) {
      resolveStats(received, 100);
      await flush();
    }
  }
  expect(updates).toContain(STALLED);
});

test("a stall that survives the reconnect is charged to the codec", async () => {
  const first = await start();
  first.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);

  await reconnect();
  first.markFrameDecoded();
  await pollStall(frozenRun(600));
  expect(failures()).toMatchObject([{ kind: "codec" }]);
});

/// Each codec earns its own reconnect; a remount clears the marker the way React does.
test("a fresh session reconnects before blaming the codec again", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
});

test("a transport stall leaves the codec its reconnect", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  // Nothing arriving: transport verdict, reconnect, codec untouched.
  await pollStall(deadRun(100));
  expect(failures()).toEqual([]);

  await reconnect();
  hook.markFrameDecoded();
  // Now a real decoder stall: it should still earn a reconnect, not lose the codec.
  await pollStall(frozenRun(200));
  expect(failures()).toEqual([]);
});
