import type { Socket } from "net";

export function websocketFrame(opcode: number, payload: Buffer<ArrayBufferLike>): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

type ParsedWebSocketFrame = {
  opcode: number;
  payload: Buffer<ArrayBufferLike>;
  consumed: number;
};

export function parseWebSocketFrame(buffer: Buffer, maxPayloadBytes = Number.MAX_SAFE_INTEGER): ParsedWebSocketFrame | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame too large");
    }
    length = Number(bigLength);
    offset += 8;
  }
  if (length > maxPayloadBytes) throw new Error("WebSocket frame too large");
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i]! ^ mask[i % 4]!;
    }
  }
  return { opcode, payload, consumed: offset + length };
}

export function sendBrowserFrame(socket: Socket, opcode: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(websocketFrame(opcode, payload));
}
