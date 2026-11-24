import { describe, expect, test } from "bun:test";
import type { AudioFormatRequest, AudioInjectionStream } from "../src/emulator-grpc.ts";
import { MIC_FORMAT } from "../src/mic-audio.ts";
import {
  MAX_AHEAD_MS,
  MicInjector,
  MicInjectors,
  PACKET_MS,
  STREAM_OPEN_DELAY_MS,
} from "../src/mic-injector.ts";

const PACKET_BYTES = 1_764;

/** Timers that run only when the test advances the clock. */
class FakeClock {
  now = 0;
  #timers: Array<{ due: number; resolve(): void }> = [];

  wait = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = { due: this.now + ms, resolve };
      this.#timers.push(timer);
      signal.addEventListener(
        "abort",
        () => {
          this.#timers = this.#timers.filter((entry) => entry !== timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await flush();
    while (true) {
      this.#timers.sort((left, right) => left.due - right.due);
      const next = this.#timers[0];
      if (!next || next.due > end) break;
      this.#timers.shift();
      this.now = Math.max(this.now, next.due);
      next.resolve();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

type FakeStream = AudioInjectionStream & {
  packets: Buffer[];
  ended: boolean;
  fail(error: Error): void;
};

function fakeStream(): FakeStream {
  let rejectDone!: (error: Error) => void;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const stream: FakeStream = {
    packets: [],
    ended: false,
    done,
    write: async (audio) => {
      if (stream.ended) throw new Error("call has ended");
      stream.packets.push(Buffer.from(audio));
    },
    end: async () => {
      stream.ended = true;
      resolveDone();
      await done;
    },
    fail: (error) => {
      stream.ended = true;
      rejectDone(error);
    },
  };
  return stream;
}

function setup() {
  const clock = new FakeClock();
  let recording = false;
  const streams: FakeStream[] = [];
  const formats: AudioFormatRequest[] = [];
  const logs: string[] = [];
  let resets = 0;
  const injector = new MicInjector("emulator-5554", {
    now: () => clock.now,
    wait: clock.wait,
    isRecording: async () => recording,
    openStream: async (format) => {
      formats.push(format);
      const stream = fakeStream();
      streams.push(stream);
      return stream;
    },
    resetStream: () => {
      resets++;
    },
    log: (message) => logs.push(message),
  });
  return {
    clock,
    injector,
    streams,
    formats,
    logs,
    resets: () => resets,
    setRecording: (value: boolean) => {
      recording = value;
    },
  };
}

/** `ms` of a constant 16-bit sample value, so packets show where they came from. */
function constantPcm(ms: number, value: number): Buffer {
  const pcm = Buffer.alloc((44_100 * 2 * ms) / 1_000);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(value, offset);
  return pcm;
}

const isSilent = (packet: Buffer) => packet.every((byte) => byte === 0);

describe("MicInjector", () => {
  test("does nothing until the first play", async () => {
    const { clock, injector, streams, setRecording } = setup();
    setRecording(true);
    await clock.advance(10_000);
    expect(streams).toEqual([]);
    expect(injector.status()).toMatchObject({ stream: "idle", source: { kind: "silence" } });
  });

  test("opens the call only after an app records for the open delay", async () => {
    const { clock, injector, streams, formats, setRecording } = setup();
    injector.play(constantPcm(1_000, 100), { label: "tone" });
    await clock.advance(5_000);
    expect(injector.status().stream).toBe("waiting");

    setRecording(true);
    await clock.advance(1_000);
    // The recording stops before the delay ends, so the wait starts again.
    setRecording(false);
    await clock.advance(500);
    setRecording(true);
    await clock.advance(STREAM_OPEN_DELAY_MS - 500);
    expect(injector.status().stream).toBe("starting");
    expect(streams).toEqual([]);

    await clock.advance(1_000);
    expect(streams.length).toBe(1);
    expect(formats).toEqual([MIC_FORMAT]);
    expect(injector.status().stream).toBe("streaming");
    await injector.dispose();
  });

  test("sends 20 ms packets at most 100 ms ahead of real time", async () => {
    const { clock, injector, streams, setRecording } = setup();
    setRecording(true);
    injector.play(constantPcm(5_000, 100), { label: "tone" });
    await clock.advance(STREAM_OPEN_DELAY_MS + 500);
    const stream = streams[0]!;
    const before = stream.packets.length;
    await clock.advance(1_000);
    const sent = (stream.packets.length - before) * PACKET_MS;
    expect(sent).toBeGreaterThanOrEqual(1_000 - PACKET_MS);
    expect(sent).toBeLessThanOrEqual(1_000 + MAX_AHEAD_MS);
    expect(stream.packets.every((packet) => packet.length === PACKET_BYTES)).toBe(true);
    expect(stream.packets[0]!.readInt16LE(0)).toBe(100);
    await injector.dispose();
  });

  test("writes nothing while no app records, and resumes on the same call", async () => {
    const { clock, injector, streams, setRecording } = setup();
    setRecording(true);
    injector.play(constantPcm(60_000, 100), { label: "tone" });
    await clock.advance(STREAM_OPEN_DELAY_MS + 1_000);
    const stream = streams[0]!;

    setRecording(false);
    await clock.advance(500);
    const paused = stream.packets.length;
    const position = injector.status().source;
    await clock.advance(5_000);
    expect(stream.packets.length).toBe(paused);
    // The source does not advance while nothing hears it.
    expect(injector.status().source).toEqual(position);

    setRecording(true);
    await clock.advance(1_000);
    expect(stream.packets.length).toBeGreaterThan(paused + 30);
    expect(streams.length).toBe(1);
    expect(stream.ended).toBe(false);
    await injector.dispose();
  });

  test("goes back to silence at the end of a file, and loops when asked", async () => {
    const { clock, injector, streams, setRecording } = setup();
    setRecording(true);
    injector.play(constantPcm(100, 100), { label: "once" });
    await clock.advance(STREAM_OPEN_DELAY_MS + 1_000);
    const once = streams[0]!.packets;
    expect(once.slice(0, 5).every((packet) => packet.readInt16LE(0) === 100)).toBe(true);
    expect(isSilent(once.at(-1)!)).toBe(true);
    expect(injector.status().source).toEqual({ kind: "silence" });

    injector.play(constantPcm(100, 7), { label: "loop", loop: true });
    const start = once.length;
    await clock.advance(1_000);
    expect(once.slice(start).every((packet) => packet.readInt16LE(0) === 7)).toBe(true);
    expect(injector.status().source).toMatchObject({ kind: "audio", label: "loop", loop: true });

    injector.stop();
    await clock.advance(200);
    expect(isSilent(once.at(-1)!)).toBe(true);
    expect(streams[0]!.ended).toBe(false);
    await injector.dispose();
  });

  test("opens a new call after a failure, with the open delay again", async () => {
    const { clock, injector, streams, logs, resets, setRecording } = setup();
    setRecording(true);
    injector.play(constantPcm(1_000, 100), { label: "tone" });
    await clock.advance(STREAM_OPEN_DELAY_MS + 500);
    streams[0]!.fail(new Error("injectAudio: grpc-status 14"));
    await clock.advance(500);
    expect(resets()).toBe(1);
    expect(injector.status()).toMatchObject({ lastError: "injectAudio: grpc-status 14" });
    expect(logs).toEqual(["emulator-5554: injectAudio: grpc-status 14"]);
    expect(streams.length).toBe(1);

    await clock.advance(STREAM_OPEN_DELAY_MS + 500);
    expect(streams.length).toBe(2);
    expect(injector.status()).toMatchObject({ stream: "streaming", lastError: null });
    await injector.dispose();
  });

  test("dispose ends the call and refuses more audio", async () => {
    const { clock, injector, streams, setRecording } = setup();
    setRecording(true);
    injector.play(constantPcm(1_000, 100), { label: "tone" });
    await clock.advance(STREAM_OPEN_DELAY_MS + 500);
    await injector.dispose();
    expect(streams[0]!.ended).toBe(true);
    expect(injector.status().stream).toBe("idle");
    expect(() => injector.play(constantPcm(100, 1), { label: "late" })).toThrow("disposed");
  });

  test("rejects empty audio", () => {
    const { injector } = setup();
    expect(() => injector.play(Buffer.alloc(0), { label: "empty" })).toThrow("no samples");
  });
});

describe("MicInjectors", () => {
  test("keeps one injector per serial and reports idle without creating one", async () => {
    const created: string[] = [];
    const injectors = new MicInjectors((serial) => {
      created.push(serial);
      return new MicInjector(serial, { openStream: async () => fakeStream() });
    });
    expect(injectors.status("emulator-5554")).toMatchObject({ stream: "idle" });
    expect(created).toEqual([]);
    expect(injectors.get("emulator-5554")).toBe(injectors.get("emulator-5554"));
    injectors.get("emulator-5556");
    expect(created).toEqual(["emulator-5554", "emulator-5556"]);
    await injectors.disposeAll();
  });
});
