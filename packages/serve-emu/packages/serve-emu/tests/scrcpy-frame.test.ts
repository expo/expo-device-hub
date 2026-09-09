import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  FramedReader,
  ScrcpyStreamError,
  parseFrameHeader,
  parseVideoPreamble,
  readFrame,
} from "../src/scrcpy.ts";
import { SCRCPY_VERSION } from "../scripts/fetch-scrcpy.ts";
import {
  PROTOCOL_GOLDEN_HEX,
  goldenBytes,
} from "./fixtures/protocol-golden.ts";

function frameHeader(
  protocol: 3 | 4,
  o: { pts?: bigint; size: number; config?: boolean; key?: boolean },
) {
  const h = Buffer.alloc(12);
  let flags = 0n;
  if (protocol === 4) {
    if (o.config) flags |= 1n << 62n;
    if (o.key) flags |= 1n << 61n;
  } else {
    if (o.config) flags |= 1n << 63n;
    if (o.key) flags |= 1n << 62n;
  }
  h.writeBigUInt64BE((o.pts ?? 0n) | flags, 0);
  h.writeUInt32BE(o.size, 8);
  return h;
}

function sessionHeader(width: number, height: number, clientResized: boolean) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x80000000 + (clientResized ? 1 : 0), 0);
  header.writeUInt32BE(width, 4);
  header.writeUInt32BE(height, 8);
  return header;
}

function videoPreamble(
  protocol: 3 | 4,
  options: { dummy: boolean; extra?: Buffer; codecId?: number },
): Buffer {
  const name = Buffer.alloc(64);
  name.write("Pixel 8", "utf8");
  const metadata = Buffer.alloc(protocol === 4 ? 16 : 12);
  metadata.writeUInt32BE(options.codecId ?? 0x68323634, 0);
  if (protocol === 4) {
    metadata.writeUInt32BE(0x80000000, 4);
    metadata.writeUInt32BE(720, 8);
    metadata.writeUInt32BE(1280, 12);
  } else {
    metadata.writeUInt32BE(720, 4);
    metadata.writeUInt32BE(1280, 8);
  }
  return Buffer.concat([
    ...(options.dummy ? [Buffer.of(0)] : []),
    name,
    metadata,
    options.extra ?? Buffer.alloc(0),
  ]);
}

class MockSock extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;
  destroy() {
    this.destroyCalls++;
    this.destroyed = true;
    this.emit("close");
  }
}

function makeReader() {
  const s = new MockSock();
  return { s, r: new FramedReader(s as unknown as Socket) };
}

describe("scrcpy protocol goldens", () => {
  test("fixtures are pinned to the vendored scrcpy 4.0 protocol", () => {
    expect(SCRCPY_VERSION).toBe("4.0");
  });

  test("documented byte fixtures are accepted by the parser", () => {
    const name = Buffer.alloc(64);
    name.write("Pixel Golden", "utf8");
    for (const [protocol, tail] of [
      [3, "v3-preamble-tail"],
      [4, "v4-preamble-tail"],
    ] as const) {
      expect(
        parseVideoPreamble(Buffer.concat([name, Buffer.from(goldenBytes(tail))])),
      ).toMatchObject({ protocol, width: 1080, height: 1920 });
    }

    expect(
      parseFrameHeader(Buffer.from(goldenBytes("v3-key-header")), 3),
    ).toMatchObject({ kind: "frame", pts: 42n, isKey: true });
    expect(
      parseFrameHeader(Buffer.from(goldenBytes("v4-key-header")), 4),
    ).toMatchObject({ kind: "frame", pts: 42n, isKey: true });
    expect(
      parseFrameHeader(Buffer.from(goldenBytes("v4-resize")), 4),
    ).toEqual({
      kind: "session",
      clientResized: true,
      width: 1080,
      height: 1920,
    });
    expect(PROTOCOL_GOLDEN_HEX["v4-resize"]).toBe(
      "800000010000043800000780",
    );
  });

  test.each([
    { protocol: 3 as const, dummy: false },
    { protocol: 3 as const, dummy: true },
    { protocol: 4 as const, dummy: false },
    { protocol: 4 as const, dummy: true },
  ])("parses v$protocol preamble (dummy=$dummy)", ({ protocol, dummy }) => {
    const extra = Buffer.of(0xaa, 0xbb, 0xcc);
    expect(parseVideoPreamble(videoPreamble(protocol, { dummy, extra }))).toEqual({
      deviceName: "Pixel 8",
      codecName: "h264",
      width: 720,
      height: 1280,
      protocol,
      extra,
    });
  });

  test("v3 config and key headers match emitted flag layouts", () => {
    expect(
      parseFrameHeader(Buffer.from("800000000000000000000004", "hex"), 3),
    ).toEqual({
      kind: "frame",
      size: 4,
      pts: 0n,
      isConfig: true,
      isKey: false,
    });
    expect(
      parseFrameHeader(Buffer.from("400000000000007b00000004", "hex"), 3),
    ).toEqual({
      kind: "frame",
      size: 4,
      pts: 123n,
      isConfig: false,
      isKey: true,
    });
  });

  test("v4 config and key headers match emitted flag layouts", () => {
    expect(
      parseFrameHeader(Buffer.from("400000000000000000000004", "hex"), 4),
    ).toEqual({
      kind: "frame",
      size: 4,
      pts: 0n,
      isConfig: true,
      isKey: false,
    });
    expect(
      parseFrameHeader(Buffer.from("200000000000007b00000004", "hex"), 4),
    ).toEqual({
      kind: "frame",
      size: 4,
      pts: 123n,
      isConfig: false,
      isKey: true,
    });
  });

  test.each([
    {
      resized: false,
      header: "80000000000002d000000500",
    },
    {
      resized: true,
      header: "80000001000002d000000500",
    },
  ])("v4 session header exposes resized=$resized", ({ resized, header }) => {
    expect(parseFrameHeader(Buffer.from(header, "hex"), 4)).toEqual({
      kind: "session",
      clientResized: resized,
      width: 720,
      height: 1280,
    });
  });

  test("fragmented dummy v4 preamble is reassembled exactly", async () => {
    const { s, r } = makeReader();
    const promise = r
      .read(81, "header")
      .then((buffer) => parseVideoPreamble(buffer));
    const preamble = videoPreamble(4, { dummy: true });
    for (const chunk of [
      preamble.subarray(0, 1),
      preamble.subarray(1, 17),
      preamble.subarray(17, 64),
      preamble.subarray(64),
    ]) {
      s.emit("data", chunk);
    }
    expect(await promise).toEqual({
      deviceName: "Pixel 8",
      codecName: "h264",
      width: 720,
      height: 1280,
      protocol: 4,
      extra: Buffer.alloc(0),
    });
  });

  test("fragmented v3 frame preserves flags, pts, and payload", async () => {
    const { s, r } = makeReader();
    const promise = readFrame(r, 3);
    const packet = Buffer.concat([
      Buffer.from("400000000000002a00000004", "hex"),
      Buffer.of(1, 2, 3, 4),
    ]);
    for (const byte of packet) s.emit("data", Buffer.of(byte));
    expect(await promise).toEqual({
      type: "frame",
      data: Buffer.of(1, 2, 3, 4),
      pts: 42n,
      isConfig: false,
      isKey: true,
    });
  });

  test("fragmented v4 session packet preserves session flags", async () => {
    const { s, r } = makeReader();
    const promise = readFrame(r, 4);
    const header = sessionHeader(720, 1280, true);
    s.emit("data", header.subarray(0, 3));
    s.emit("data", header.subarray(3, 11));
    s.emit("data", header.subarray(11));
    expect(await promise).toEqual({
      type: "session",
      width: 720,
      height: 1280,
      clientResized: true,
    });
  });
});

test("clean EOF when stream ends before a header (read after end)", async () => {
  const { s, r } = makeReader();
  s.emit("end");
  const err = await r.read(12, "header").catch((e) => e);
  expect(err).toBeInstanceOf(ScrcpyStreamError);
  expect(err.code).toBe("clean-eof");
});

test("overflow destroys reader and cannot resume", async () => {
  const { s, r } = makeReader();
  s.emit("data", Buffer.allocUnsafe(33 * 1024 * 1024));
  const err = await r.read(4, "header").catch((e) => e);
  expect(err.code).toBe("reader-overflow");
  expect(s.destroyed).toBe(true);
  s.emit("data", Buffer.allocUnsafe(33 * 1024 * 1024));
  expect(s.destroyCalls).toBe(1);
  const err2 = await r.read(4, "header").catch((e) => e);
  expect(err2.code).toBe("reader-overflow");
});

// The server maps readFrame's result to a terminal status: null → "stopped"
// (clean shutdown), thrown ScrcpyStreamError → "error" with code/meta.
describe("readFrame terminal mapping", () => {
  test("clean EOF at a frame boundary returns null (→ status 'stopped')", async () => {
    const { s, r } = makeReader();
    s.emit("end");
    expect(await readFrame(r, 4)).toBeNull();
  });

  test("truncated header throws truncated-header (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", Buffer.alloc(6));
    s.emit("end");
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("truncated-header");
  });

  test("truncated payload throws truncated-payload (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 100 }));
    s.emit("data", Buffer.alloc(40));
    s.emit("end");
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("truncated-payload");
    expect(err.meta).toEqual({ needed: 100, had: 40 });
  });

  test("zero-size frame header throws invalid-frame-size (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 0 }));
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("invalid-frame-size");
  });

  test("a complete frame is parsed and returned", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 4, key: true }));
    s.emit("data", Buffer.of(1, 2, 3, 4));
    const f = await readFrame(r, 4);
    expect(f?.type).toBe("frame");
    if (f?.type === "frame") {
      expect(f.isKey).toBe(true);
      expect(f.data).toEqual(Buffer.of(1, 2, 3, 4));
    }
  });
});
