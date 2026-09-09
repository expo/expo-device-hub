import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import type { ScrcpySession, VideoPacket } from "../src/scrcpy.ts";
import {
  adaptScrcpySession,
  prepareDecodableScrcpySession,
  startEmuSession,
} from "../src/stream-session.ts";

function fakeScrcpy(
  close: () => unknown = () => {},
  readFrame: () => Promise<VideoPacket | null> = async () => null,
): {
  raw: ScrcpySession;
  proc: EventEmitter;
  control: EventEmitter;
} {
  const proc = new EventEmitter();
  const control = new EventEmitter();
  return {
    proc,
    control,
    raw: {
      transport: "scrcpy",
      serial: "emulator-5554",
      meta: {
        deviceName: "fake",
        codecId: "h264",
        width: 576,
        height: 1280,
      },
      proc,
      controlSocket: control,
      readFrame,
      close,
    } as unknown as ScrcpySession,
  };
}

describe("stream session", () => {
  test("rejects strict gRPC selection for physical devices", async () => {
    await expect(
      startEmuSession({
        mode: "grpc-screenshot",
        grpcImageMode: "png",
        inputSource: "grpc",
        serial: "physical-device",
      }),
    ).rejects.toThrow("requires an Android Emulator serial");
  });

  test("adapts scrcpy controls, failures, and void cleanup", async () => {
    const packets: Buffer[] = [];
    let writerClosed = false;
    let rawClosed = 0;
    const controls = new ControlInputQueue({
      writer: {
        async write(packet) {
          packets.push(packet);
        },
        close() {
          writerClosed = true;
        },
      },
    });
    const { raw, proc } = fakeScrcpy(() => {
      rawClosed++;
    });
    const session = adaptScrcpySession(raw, controls);
    const failures: string[] = [];
    const unsubscribe = session.onFatal((failure) =>
      failures.push(failure.message),
    );

    await session.controls.enqueueVideoReset().completion;
    proc.emit("exit", 9, null);
    expect(session.mode).toBe("scrcpy");
    expect(session.rawScrcpy).toBe(raw);
    expect(packets).toEqual([Buffer.from([17])]);
    expect(failures).toEqual([
      "scrcpy exited with code 9 signal null",
    ]);

    unsubscribe();
    proc.emit("exit", 10, null);
    expect(failures).toHaveLength(1);
    await session.close();
    await session.close();
    expect(rawClosed).toBe(1);
    expect(writerClosed).toBe(true);
  });

  test("emits only the first fatal scrcpy failure and replays it to late subscribers", async () => {
    const { raw, proc, control } = fakeScrcpy();
    const session = adaptScrcpySession(raw);
    const early: unknown[] = [];
    const late: unknown[] = [];
    session.onFatal((failure) => early.push(failure));

    control.emit("error", new Error("control failed"));
    proc.emit("exit", 23, null);
    session.onFatal((failure) => late.push(failure));

    expect(early).toEqual([
      {
        message: "scrcpy control socket error: control failed",
        code: "control-socket-error",
      },
    ]);
    expect(late).toEqual(early);
    await session.close();
  });

  test("keeps scrcpy private until buffered config and a keyframe are ready", async () => {
    const config: VideoPacket = {
      type: "frame",
      data: Buffer.from([
        0, 0, 0, 1, 0x67, 0x64,
        0, 0, 0, 1, 0x68, 0xee,
      ]),
      pts: 1n,
      isConfig: true,
      isKey: false,
    };
    const delta: VideoPacket = {
      type: "frame",
      data: Buffer.from([0, 0, 0, 1, 0x41]),
      pts: 2n,
      isConfig: false,
      isKey: false,
    };
    const key: VideoPacket = {
      type: "frame",
      data: Buffer.from([0, 0, 0, 1, 0x65]),
      pts: 3n,
      isConfig: false,
      isKey: true,
    };
    const queued = [config, delta];
    let releaseFrame!: (packet: VideoPacket | null) => void;
    const { raw } = fakeScrcpy(
      () => {},
      () => {
        const packet = queued.shift();
        return packet
          ? Promise.resolve(packet)
          : new Promise((resolve) => {
              releaseFrame = resolve;
            });
      },
    );

    let settled = false;
    const preparing = prepareDecodableScrcpySession(raw, undefined, 1_000)
      .then((session) => {
        settled = true;
        return session;
      });
    await Bun.sleep(0);
    expect(settled).toBe(false);

    releaseFrame(key);
    const session = await preparing;
    expect(await session.readFrame()).toEqual(config);
    expect(await session.readFrame()).toEqual(delta);
    expect(await session.readFrame()).toEqual(key);
    await session.close();
  });

  test("closes scrcpy when the stream ends before becoming decodable", async () => {
    let closes = 0;
    const { raw } = fakeScrcpy(() => {
      closes++;
    });

    await expect(
      prepareDecodableScrcpySession(raw, undefined, 1_000),
    ).rejects.toThrow("before producing decodable H.264 output");
    expect(closes).toBe(1);
  });
});
