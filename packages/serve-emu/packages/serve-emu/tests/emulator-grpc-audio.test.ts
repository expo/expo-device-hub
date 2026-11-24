import http2 from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { describe, expect, test } from "bun:test";
import {
  type AudioFormatRequest,
  audioFrameBytes,
  EmulatorGrpcClient,
  encodeAudioFormat,
  encodeAudioPacket,
  GrpcMessageParser,
  MAX_AUDIO_PACKET_BYTES,
} from "../src/emulator-grpc.ts";

const REALTIME_44K: AudioFormatRequest = {
  samplingRate: 44_100,
  channels: "mono",
  sampleFormat: "s16",
  mode: "realtime",
};

// samplingRate 44100 (varint c4 d8 02), channels Mono (default, omitted), AUD_FMT_S16, MODE_REAL_TIME.
const REALTIME_44K_BYTES = [0x08, 0xc4, 0xd8, 0x02, 0x18, 0x01, 0x20, 0x01];

describe("emulator audio protobuf", () => {
  test("encodes AudioFormat with proto3 defaults omitted", () => {
    expect(encodeAudioFormat(REALTIME_44K)).toEqual(Buffer.from(REALTIME_44K_BYTES));
    expect(
      encodeAudioFormat({
        samplingRate: 16_000,
        channels: "stereo",
        sampleFormat: "u8",
        mode: "blocking",
      }),
    ).toEqual(Buffer.from([0x08, 0x80, 0x7d, 0x10, 0x01]));
  });

  test("encodes the format, timestamp, and audio of an AudioPacket", () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    expect(encodeAudioPacket({ format: REALTIME_44K, audio })).toEqual(
      Buffer.from([0x0a, 0x08, ...REALTIME_44K_BYTES, 0x1a, 0x04, 1, 2, 3, 4]),
    );
    expect(encodeAudioPacket({ audio, timestampUs: 300n })).toEqual(
      Buffer.from([0x10, 0xac, 0x02, 0x1a, 0x04, 1, 2, 3, 4]),
    );
    expect(encodeAudioPacket({ audio: Buffer.alloc(0) })).toEqual(Buffer.alloc(0));
  });

  test("rejects formats and packets that the emulator would reject", () => {
    expect(() => encodeAudioFormat({ ...REALTIME_44K, samplingRate: 48_001 })).toThrow(RangeError);
    expect(() => encodeAudioFormat({ ...REALTIME_44K, samplingRate: 0 })).toThrow(RangeError);
    expect(() =>
      encodeAudioFormat({ ...REALTIME_44K, mode: "fast" as AudioFormatRequest["mode"] }),
    ).toThrow(RangeError);
    expect(() => encodeAudioPacket({ audio: Buffer.alloc(MAX_AUDIO_PACKET_BYTES + 1) })).toThrow(
      RangeError,
    );
  });

  test("counts the bytes of one sample frame", () => {
    expect(audioFrameBytes(REALTIME_44K)).toBe(2);
    expect(audioFrameBytes({ ...REALTIME_44K, channels: "stereo" })).toBe(4);
    expect(audioFrameBytes({ ...REALTIME_44K, sampleFormat: "u8" })).toBe(1);
  });
});

type InjectServer = {
  client: EmulatorGrpcClient;
  /** Decoded AudioPacket bodies, in order, for each call. */
  calls: Buffer[][];
  headers: http2.IncomingHttpHeaders[];
  close(): Promise<void>;
};

/** An HTTP/2 server that collects injectAudio packets, then answers with `respond`. */
async function injectServer(
  respond: (stream: ServerHttp2Stream, packets: Buffer[]) => void = (stream) => {
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end();
  },
): Promise<InjectServer> {
  const calls: Buffer[][] = [];
  const headers: http2.IncomingHttpHeaders[] = [];
  const server = http2.createServer();
  server.on("stream", (stream: ServerHttp2Stream, requestHeaders) => {
    headers.push(requestHeaders);
    const packets: Buffer[] = [];
    calls.push(packets);
    const parser = new GrpcMessageParser(1024 * 1024, (message) => packets.push(message));
    stream.on("data", (chunk: Buffer) => parser.push(chunk));
    stream.on("end", () => respond(stream, packets));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const client = new EmulatorGrpcClient({ port: address.port, token: "t", avdName: null });
  return {
    client,
    calls,
    headers,
    close: async () => {
      client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("EmulatorGrpcClient.injectAudio", () => {
  test("sends the format in the first packet only, then half-closes", async () => {
    const server = await injectServer();
    try {
      const call = server.client.injectAudio(REALTIME_44K);
      await call.write(Buffer.from([1, 0, 2, 0]));
      await call.write(Buffer.from([3, 0]));
      await call.end();
      expect(server.headers[0]?.[":path"]).toBe(
        "/android.emulation.control.EmulatorController/injectAudio",
      );
      expect(server.headers[0]?.authorization).toBe("Bearer t");
      expect(server.calls[0]).toEqual([
        encodeAudioPacket({ format: REALTIME_44K, audio: Buffer.from([1, 0, 2, 0]) }),
        encodeAudioPacket({ audio: Buffer.from([3, 0]) }),
      ]);
      await expect(call.write(Buffer.from([4, 0]))).rejects.toThrow("call has ended");
    } finally {
      await server.close();
    }
  });

  test("rejects a packet that splits a sample frame", async () => {
    const server = await injectServer();
    try {
      const call = server.client.injectAudio(REALTIME_44K);
      await expect(call.write(Buffer.from([1, 2, 3]))).rejects.toThrow(RangeError);
      await call.end();
      expect(server.calls[0]).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("reports a non-zero grpc-status from the emulator", async () => {
    const server = await injectServer((stream) => {
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({
          "grpc-status": "9",
          "grpc-message": encodeURIComponent("another microphone is active"),
        }),
      );
      stream.end();
    });
    try {
      const call = server.client.injectAudio(REALTIME_44K);
      await call.write(Buffer.from([0, 0]));
      await expect(call.end()).rejects.toThrow(
        "injectAudio: grpc-status 9 (another microphone is active)",
      );
    } finally {
      await server.close();
    }
  });

  test("cancels the call on abort", async () => {
    let cancelled = false;
    const server = await injectServer();
    try {
      const abort = new AbortController();
      const call = server.client.injectAudio(REALTIME_44K, abort.signal);
      await call.write(Buffer.from([0, 0]));
      abort.abort(new Error("source stopped"));
      await call.done.catch((error: Error) => {
        cancelled = error.message === "source stopped";
      });
      expect(cancelled).toBe(true);
      await expect(call.write(Buffer.from([0, 0]))).rejects.toThrow("call has ended");
    } finally {
      await server.close();
    }
  });

  test("refuses an aborted signal and an invalid format before it opens a call", async () => {
    const server = await injectServer();
    try {
      const abort = new AbortController();
      abort.abort();
      expect(() => server.client.injectAudio(REALTIME_44K, abort.signal)).toThrow();
      expect(() => server.client.injectAudio({ ...REALTIME_44K, samplingRate: 96_000 })).toThrow(
        RangeError,
      );
      expect(server.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
