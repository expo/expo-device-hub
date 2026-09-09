import http2 from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { describe, expect, test } from "bun:test";
import {
  decodeEmulatorImage,
  EmulatorGrpcClient,
  encodeImageFormat,
  encodeKeyboardEvent,
  encodeTouchEvent,
  ensureEmulatorGrpcEndpoint,
  findEmulatorGrpcEndpoint,
  GrpcMessagePacer,
  GrpcMessageParser,
  IMAGE_TRANSPORT_MMAP,
  IMG_FORMAT_RGB888,
  parseEmulatorGrpcPort,
} from "../src/emulator-grpc.ts";
import type { ExecResult } from "../src/exec.ts";

function grpcFrame(message: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + message.length);
  frame[0] = 0;
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

describe("gRPC message framing", () => {
  test("assembles byte-fragmented messages without cumulative concatenation", () => {
    const first = Buffer.allocUnsafe(4_096);
    for (let index = 0; index < first.length; index++) {
      first[index] = index % 251;
    }
    const second = Buffer.from("next frame");
    const input = Buffer.concat([grpcFrame(first), grpcFrame(second)]);
    const messages: Buffer[] = [];
    const parser = new GrpcMessageParser(8_192, (message) => {
      messages.push(message);
    });

    const originalConcat = Buffer.concat;
    let concatenatedBytes = 0;
    Object.defineProperty(Buffer, "concat", {
      configurable: true,
      value: (list: readonly Uint8Array[], totalLength?: number) => {
        const output = originalConcat(list, totalLength);
        concatenatedBytes += output.length;
        return output;
      },
    });
    try {
      for (let offset = 0; offset < input.length; offset++) {
        parser.push(input.subarray(offset, offset + 1));
      }
    } finally {
      Object.defineProperty(Buffer, "concat", {
        configurable: true,
        value: originalConcat,
      });
    }

    expect(messages).toEqual([first, second]);
    expect(concatenatedBytes).toBeLessThanOrEqual(input.length * 2);
  });

  test("validates fragmented headers before allocating message storage", () => {
    const oversizedHeader = Buffer.from([0, 0, 0, 0, 9]);
    const oversized = new GrpcMessageParser(8, () => {});
    oversized.push(oversizedHeader.subarray(0, 2));
    expect(() => oversized.push(oversizedHeader.subarray(2))).toThrow(
      "gRPC message 9 exceeds 8 byte limit",
    );

    const compressed = new GrpcMessageParser(8, () => {});
    expect(() => compressed.push(Buffer.from([1, 0, 0, 0, 0]))).toThrow(
      "compressed gRPC frames are unsupported",
    );
  });

  test("pauses upstream and emits at most one message per pacing slot", () => {
    class FakeClock {
      nowMs = 0;
      nextId = 1;
      tasks = new Map<number, { at: number; callback: () => void }>();

      now = () => this.nowMs;
      setTimeout = (callback: () => void, delayMs: number): number => {
        const id = this.nextId++;
        this.tasks.set(id, {
          at: this.nowMs + Math.max(0, delayMs),
          callback,
        });
        return id;
      };
      clearTimeout = (id: unknown): void => {
        this.tasks.delete(id as number);
      };
      advance(ms: number): void {
        const target = this.nowMs + ms;
        for (;;) {
          const next = [...this.tasks.entries()]
            .filter(([, task]) => task.at <= target)
            .sort((left, right) => left[1].at - right[1].at)[0];
          if (!next) break;
          const [id, task] = next;
          this.tasks.delete(id);
          this.nowMs = task.at;
          task.callback();
        }
        this.nowMs = target;
      }
    }

    const clock = new FakeClock();
    const stream = {
      pauses: 0,
      resumes: 0,
      pause() {
        this.pauses++;
      },
      resume() {
        this.resumes++;
      },
    };
    const messages: string[] = [];
    const failures: Error[] = [];
    const pacingEvents = { received: 0, emitted: 0, coalesced: 0 };
    const controller = new AbortController();
    const pacer = new GrpcMessagePacer({
      stream,
      maxMessageBytes: 1_024,
      messageIntervalMs: 100,
      signal: controller.signal,
      clock,
      onMessage: (message) => messages.push(message.toString("utf8")),
      onPacingEvent: (event) => {
        pacingEvents[event]++;
      },
      onError: (error) => failures.push(error),
    });

    pacer.push(
      Buffer.concat([
        grpcFrame(Buffer.from("one")),
        grpcFrame(Buffer.from("two")),
        grpcFrame(Buffer.from("three")),
      ]),
    );

    expect(messages).toEqual(["one"]);
    expect(pacingEvents).toEqual({ received: 3, emitted: 1, coalesced: 1 });
    expect(stream.pauses).toBe(1);
    expect(stream.resumes).toBe(0);

    clock.advance(99);
    expect(messages).toEqual(["one"]);
    clock.advance(1);
    expect(messages).toEqual(["one", "three"]);
    expect(stream.resumes).toBe(0);

    clock.advance(100);
    expect(stream.resumes).toBe(1);
    expect(failures).toEqual([]);
    expect(pacingEvents).toEqual({ received: 3, emitted: 2, coalesced: 1 });

    pacer.push(grpcFrame(Buffer.from("four")));
    expect(messages).toEqual(["one", "three", "four"]);
    expect(pacingEvents).toEqual({ received: 4, emitted: 3, coalesced: 1 });
    controller.abort(new Error("stream cancelled"));
    clock.advance(1_000);
    expect(stream.resumes).toBe(1);
    expect(messages).toEqual(["one", "three", "four"]);
  });
});

describe("emulator gRPC discovery", () => {
  test("parses active and newly started endpoint output", () => {
    expect(parseEmulatorGrpcPort('OK: { "port": "8554" }')).toBe(8554);
    expect(
      parseEmulatorGrpcPort("OK: gRPC endpoint available at port 43127"),
    ).toBe(43127);
  });

  test("rejects missing and invalid ports", () => {
    expect(parseEmulatorGrpcPort("OK")).toBeNull();
    expect(parseEmulatorGrpcPort("port 70000")).toBeNull();
  });

  test("selects the newest live discovery file for the requested emulator", () => {
    const files = new Map([
      ["/run/pid_10.ini", "port.serial=5554\ngrpc.port=8554\ngrpc.token=older"],
      [
        "/run/pid_11_info.ini",
        "port.serial=5554\ngrpc.port=8555\ngrpc.token=newer\navd.name=Pixel_9",
      ],
      ["/run/pid_12.ini", "port.serial=5556\ngrpc.port=8556"],
    ]);
    const endpoint = findEmulatorGrpcEndpoint("emulator-5554", {
      discoveryDirs: () => ["/run"],
      readDirectory: () => ["pid_10.ini", "pid_11_info.ini", "pid_12.ini"],
      processIsAlive: () => true,
      readText: (path) => files.get(path)!,
      modifiedMs: (path) => (path.includes("11") ? 20 : 10),
    });

    expect(endpoint).toEqual({
      port: 8555,
      token: "newer",
      avdName: "Pixel_9",
    });
  });

  test("retries activation and preserves the discovered bearer token", async () => {
    let attempts = 0;
    let active = false;
    const warnings: string[] = [];
    const success = (): ExecResult<string> => ({
      status: 0,
      signal: null,
      stdout: 'OK: { "port": "8554" }',
      stderr: "",
      timedOut: false,
      error: null,
    });
    const endpoint = await ensureEmulatorGrpcEndpoint(
      "emulator-5554",
      undefined,
      {
        discoveryDirs: () => ["/run"],
        readDirectory: () => (active ? ["pid_11.ini"] : []),
        processIsAlive: () => true,
        readText: () =>
          "port.serial=5554\ngrpc.port=8554\ngrpc.token=secret\navd.name=Pixel_9",
        modifiedMs: () => 1,
        portIsReachable: async (port) => active && port === 8554,
        pickAvailablePort: async () => 8554,
        runAdb: async () => {
          attempts++;
          if (attempts === 1) {
            return { ...success(), status: 1, stdout: "KO: busy" };
          }
          active = true;
          return success();
        },
        wait: async () => {},
        warn: (message) => warnings.push(message),
      },
    );

    expect(attempts).toBe(2);
    expect(endpoint).toEqual({
      port: 8554,
      token: "secret",
      avdName: "Pixel_9",
    });
    expect(warnings).toEqual([]);
  });

  test("warns when an explicitly selected endpoint has no bearer token", async () => {
    const warnings: string[] = [];
    await ensureEmulatorGrpcEndpoint("emulator-5554", undefined, {
      discoveryDirs: () => ["/run"],
      readDirectory: () => ["pid_11.ini"],
      processIsAlive: () => true,
      readText: () => "port.serial=5554\ngrpc.port=8554",
      modifiedMs: () => 1,
      portIsReachable: async () => true,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("has no bearer token");
    expect(warnings[0]).toContain("explicitly selected");
  });
});

describe("EmulatorGrpcClient HTTP/2 integration", () => {
  test("sends the discovered bearer token and decodes a screenshot", async () => {
    const imageBody = Buffer.from([
      0x0a, 0x06, 0x08, 0x02, 0x18, 0x02, 0x20, 0x01, 0x22, 0x06, 1, 2, 3, 4, 5,
      6, 0x28, 0x01, 0x30, 0x01,
    ]);
    let authorization: string | undefined;
    const server = http2.createServer();
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      authorization = headers.authorization as string | undefined;
      stream.respond({
        ":status": 200,
        "content-type": "application/grpc",
        "grpc-status": "0",
      });
      stream.end(grpcFrame(imageBody));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test port");
    const client = new EmulatorGrpcClient({
      port: address.port,
      token: "discovered-token",
      avdName: "Pixel_9",
    });

    try {
      const image = await client.getScreenshot({ format: 2 });
      expect(authorization).toBe("Bearer discovered-token");
      expect(image).toMatchObject({ width: 2, height: 1, format: 2, seq: 1 });
      expect(image.image).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    } finally {
      client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("fails a screenshot stream that stalls after a decoded image", async () => {
    const imageBody = Buffer.from([
      0x0a, 0x06, 0x08, 0x02, 0x18, 0x02, 0x20, 0x01, 0x22, 0x06, 1, 2, 3, 4, 5,
      6,
    ]);
    const server = http2.createServer();
    server.on("stream", (stream: ServerHttp2Stream) => {
      stream.respond({
        ":status": 200,
        "content-type": "application/grpc",
      });
      stream.write(grpcFrame(imageBody));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test port");
    const client = new EmulatorGrpcClient(
      { port: address.port, token: null, avdName: null },
      { unaryTimeoutMs: 25, streamInactivityTimeoutMs: 25 },
    );
    const images: unknown[] = [];

    try {
      await expect(
        client.streamScreenshot(
          { format: 2 },
          (image) => images.push(image),
          new AbortController().signal,
          { maxFps: 60 },
        ),
      ).rejects.toThrow(
        "no decoded message received for 25ms; health probe failed",
      );
      expect(images).toHaveLength(1);
    } finally {
      client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("keeps a quiet static screenshot stream healthy with unary probes", async () => {
    const imageBody = Buffer.from([
      0x0a, 0x06, 0x08, 0x02, 0x18, 0x02, 0x20, 0x01, 0x22, 0x06, 1, 2, 3, 4, 5,
      6,
    ]);
    const server = http2.createServer();
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      stream.respond({
        ":status": 200,
        "content-type": "application/grpc",
        ...(headers[":path"]?.toString().endsWith("/getScreenshot")
          ? { "grpc-status": "0" }
          : {}),
      });
      if (headers[":path"]?.toString().endsWith("/getScreenshot")) {
        stream.end(grpcFrame(imageBody));
      } else {
        stream.write(grpcFrame(imageBody));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test port");
    const client = new EmulatorGrpcClient(
      { port: address.port, token: null, avdName: null },
      { unaryTimeoutMs: 100, streamInactivityTimeoutMs: 25 },
    );
    const controller = new AbortController();
    const images: unknown[] = [];
    const sources: string[] = [];

    try {
      await client.streamScreenshot(
        { format: 2 },
        (image, source) => {
          images.push(image);
          sources.push(source);
          if (images.length === 2) controller.abort();
        },
        controller.signal,
        { maxFps: 60 },
      );
      expect(images).toHaveLength(2);
      expect(sources).toEqual(["stream", "probe"]);
    } finally {
      client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("emulator image protobuf", () => {
  test("encodes ImageFormat.transport field 6 with an MMAP file handle", () => {
    expect(
      encodeImageFormat({
        format: IMG_FORMAT_RGB888,
        width: 3,
        height: 4,
        transport: {
          channel: IMAGE_TRANSPORT_MMAP,
          handle: "file:///tmp/x",
        },
      }),
    ).toEqual(
      Buffer.from([
        0x08,
        0x02,
        0x18,
        0x03,
        0x20,
        0x04,
        0x32,
        0x11,
        0x08,
        0x01,
        0x12,
        0x0d,
        ...Buffer.from("file:///tmp/x"),
      ]),
    );
  });

  test("requires a client-owned file URL for MMAP", () => {
    expect(() =>
      encodeImageFormat({
        format: IMG_FORMAT_RGB888,
        transport: { channel: IMAGE_TRANSPORT_MMAP, handle: "/tmp/x" },
      }),
    ).toThrow("requires a file:/// handle");
  });

  test("decodes metadata-only MMAP image notifications with empty bytes", () => {
    const format = Buffer.from([
      0x08,
      0x02,
      0x18,
      0x03,
      0x20,
      0x04,
      0x32,
      0x11,
      0x08,
      0x01,
      0x12,
      0x0d,
      ...Buffer.from("file:///tmp/x"),
    ]);
    const image = decodeEmulatorImage(
      Buffer.from([0x0a, format.length, ...format, 0x28, 0x07, 0x30, 0x7b]),
    );

    expect(image).toMatchObject({
      format: IMG_FORMAT_RGB888,
      width: 3,
      height: 4,
      seq: 7,
      timestampUs: 123n,
    });
    expect(image.image).toHaveLength(0);
  });

  test("rejects truncated length-delimited fields", () => {
    expect(() => decodeEmulatorImage(Buffer.from([0x0a, 0x05, 0x08]))).toThrow(
      "truncated protobuf length-delimited field",
    );
  });

  test("rejects overlong varints", () => {
    const overlong = Buffer.from([
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
    ]);
    expect(() => decodeEmulatorImage(overlong)).toThrow(
      "protobuf varint exceeds 10 bytes",
    );
  });
});

describe("emulator keyboard protobuf", () => {
  test("encodes explicit key-down and key-up event types", () => {
    expect(encodeKeyboardEvent({ evdev: 28, eventType: "down" })).toEqual(
      Buffer.from([0x08, 0x01, 0x18, 0x1c]),
    );
    expect(encodeKeyboardEvent({ evdev: 28, eventType: "up" })).toEqual(
      Buffer.from([0x08, 0x01, 0x10, 0x01, 0x18, 0x1c]),
    );
    expect(encodeKeyboardEvent({ evdev: 28, eventType: "press" })).toEqual(
      Buffer.from([0x08, 0x01, 0x10, 0x02, 0x18, 0x1c]),
    );
  });

  test("defaults key requests to a complete keypress", () => {
    expect(encodeKeyboardEvent({ key: "GoBack" })).toEqual(
      Buffer.concat([
        Buffer.from([0x10, 0x02, 0x22, 0x06]),
        Buffer.from("GoBack"),
      ]),
    );
  });
});

describe("emulator touch protobuf", () => {
  test("keeps an all-zero touch as a present empty sub-message", () => {
    expect(
      encodeTouchEvent([{ x: 0, y: 0, identifier: 0, pressure: 0 }]),
    ).toEqual(Buffer.from([0x0a, 0x00]));
  });
});
