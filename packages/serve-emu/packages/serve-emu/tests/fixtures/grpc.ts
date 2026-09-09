import {
  encodeImageFormat,
  type ImageFormatRequest,
} from "../../src/emulator-grpc.ts";

/** Wrap a protobuf message in the uncompressed five-byte gRPC envelope. */
export function grpcFrame(message: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + message.length);
  frame[0] = 0;
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new RangeError("fixture varint must be unsigned");
  const bytes: number[] = [];
  do {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(remaining ? byte | 0x80 : byte);
  } while (remaining);
  return Buffer.from(bytes);
}

/** Encode the Image response fields used by the real HTTP/2 capture fixtures. */
export function encodeEmulatorImage(
  image: ImageFormatRequest & { image: Buffer; seq?: number; timestampUs?: bigint },
): Buffer {
  const format = encodeImageFormat(image);
  return Buffer.concat([
    Buffer.from([0x0a]), varint(format.length), format,
    Buffer.from([0x22]), varint(image.image.length), image.image,
    Buffer.from([0x28]), varint(image.seq ?? 0),
    Buffer.from([0x30]), varint(image.timestampUs ?? 0n),
  ]);
}
