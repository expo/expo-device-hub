import { describe, expect, test } from "bun:test";
import { defaultSocketPath } from "../src/paths.mjs";
import {
  FLAGS,
  HEADER_BYTES,
  RecordReader,
  rotationCommand,
  settingsCommand,
} from "../src/protocol.mjs";

function record(
  flags,
  payload = Buffer.alloc(0),
  { pts = 0n, width = 2, height = 2, fps = 60 } = {},
) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("GPC1", 0, "ascii");
  header.writeUInt32BE(payload.length, 4);
  header.writeBigUInt64BE(pts, 8);
  header.writeUInt32BE(flags, 16);
  header.writeUInt32BE(width, 20);
  header.writeUInt32BE(height, 24);
  header.writeUInt32BE(fps, 28);
  return Buffer.concat([header, payload]);
}

describe("RecordReader", () => {
  test("reassembles records split at any byte", () => {
    const stream = Buffer.concat([
      record(FLAGS.hello, Buffer.from("{}"), { width: 1080, height: 2424 }),
      record(FLAGS.keyFrame, Buffer.from([0, 0, 0, 1, 0x65]), { pts: 7n }),
    ]);
    const seen = [];
    const reader = new RecordReader((entry) => seen.push(entry));
    for (const byte of stream) reader.push(Buffer.from([byte]));
    expect(seen.map((entry) => entry.flags)).toEqual([FLAGS.hello, FLAGS.keyFrame]);
    expect(seen[0].width).toBe(1080);
    expect(seen[1].pts).toBe(7n);
    expect([...seen[1].payload]).toEqual([0, 0, 0, 1, 0x65]);
  });

  test("rejects a wrong magic", () => {
    const bytes = record(FLAGS.frame, Buffer.from([1]));
    bytes.write("XPC1", 0, "ascii");
    expect(() => new RecordReader(() => {}).push(bytes)).toThrow("magic");
  });
});

describe("settingsCommand", () => {
  test("encodes the S command big-endian", () => {
    expect([...settingsCommand({ maxSize: 1280, fps: 60, bitRate: 8_000_000 })]).toEqual([
      0x53, 0, 0, 5, 0, 0, 0, 0, 60, 0, 0x7a, 0x12, 0,
    ]);
  });

  test("rejects values outside the protocol bounds", () => {
    expect(() => settingsCommand({ fps: 121 })).toThrow(RangeError);
    expect(() => settingsCommand({ maxSize: 4097 })).toThrow(RangeError);
    // The agent refuses a cap from 1 to 15.
    expect(() => settingsCommand({ maxSize: 4 })).toThrow(RangeError);
    expect(settingsCommand({ maxSize: 16 }).readUInt32BE(1)).toBe(16);
    expect(() => settingsCommand({ bitRate: 99_999 })).toThrow(RangeError);
  });
});

describe("rotationCommand", () => {
  test("encodes the R command with Android's display rotation", () => {
    expect([...rotationCommand(0)]).toEqual([0x52, 0, 0, 0, 0]);
    expect([...rotationCommand(3)]).toEqual([0x52, 0, 0, 0, 3]);
  });

  test("rejects rotations other than 0 to 3", () => {
    expect(() => rotationCommand(4)).toThrow(RangeError);
    expect(() => rotationCommand(-1)).toThrow(RangeError);
    expect(() => rotationCommand(1.5)).toThrow(RangeError);
  });
});

test("default socket path is named by adb serial", () => {
  expect(defaultSocketPath("emulator-5554", "/tmp/capture")).toBe(
    "/tmp/capture/emulator-5554.sock",
  );
});
