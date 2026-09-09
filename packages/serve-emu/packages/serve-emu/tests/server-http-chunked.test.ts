import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { expect, test } from "bun:test";
import type { ScrcpySession } from "../src/scrcpy.ts";
import { startServer } from "../src/server.ts";

function fakeSession(): ScrcpySession {
  const controlSocket = new EventEmitter() as EventEmitter & {
    write(packet: Buffer): boolean;
  };
  controlSocket.write = () => true;
  let resolveFrame!: (frame: null) => void;
  const frame = new Promise<null>((resolve) => {
    resolveFrame = resolve;
  });
  return {
    transport: "scrcpy",
    meta: {
      deviceName: "chunked-test",
      codecId: "h264",
      width: 720,
      height: 1280,
    },
    protocol: 3,
    videoReader: {} as never,
    controlSocket: controlSocket as never,
    proc: new EventEmitter() as never,
    scid: "00000001",
    localPort: 27_200,
    serial: "device-test",
    readFrame: () => frame,
    close() {
      resolveFrame(null);
    },
  };
}

/**
 * The server answers 413 and resets the connection while the client is still
 * writing chunks, so a reset is part of the behavior under test, not a failure.
 * Swallow it and let `close` resolve with whatever response arrived; the
 * timeout still catches a server that never answers.
 */
function isConnectionReset(error: NodeJS.ErrnoException): boolean {
  return error.code === "ECONNRESET" || error.code === "EPIPE";
}

function rawChunkedRequest(port: number, body: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port });
    const ignoreWriteError = () => {};
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      fail(new Error("Timed out waiting for the chunked HTTP response"));
    }, 5_000);
    socket.setNoDelay(true);
    socket.on("connect", () => {
      socket.write(
        "POST /api/tap HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Content-Type: application/json\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "Connection: close\r\n\r\n",
        ignoreWriteError,
      );
      for (let offset = 0; offset < body.length; offset += 97) {
        const chunk = body.slice(offset, offset + 97);
        socket.write(
          `${Buffer.byteLength(chunk).toString(16)}\r\n`,
          ignoreWriteError,
        );
        socket.write(chunk, ignoreWriteError);
        socket.write("\r\n", ignoreWriteError);
      }
      // Keep the writable side open so Bun can finish parsing the terminal
      // chunk and send its response before the client half-closes the socket.
      socket.write("0\r\n\r\n", ignoreWriteError);
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (isConnectionReset(error)) return;
      fail(error);
    });
  });
}

test("real Bun HTTP rejects oversized chunked JSON with structured 413", async () => {
  const session = fakeSession();
  const started = await startServer(
    { serial: session.serial, port: 0 },
    {
      startScrcpy: async () => session,
      listAllDevices: async () => [
        { serial: session.serial, state: "device" },
      ],
    },
  );
  try {
    const body = JSON.stringify({ x: 0.5, padding: "x".repeat(9_000) });
    const response = await rawChunkedRequest(started.server.port, body);

    expect(response).toContain(" 413 ");
    expect(response).toContain('"code":"payload-too-large"');
  } finally {
    await started.stop();
  }
});
