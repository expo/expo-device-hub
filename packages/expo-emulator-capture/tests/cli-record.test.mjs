import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function wireRecord(flags, payload) {
  const header = Buffer.alloc(32);
  header.write("GPC1");
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt32BE(flags, 16);
  header.writeUInt32BE(32, 20);
  header.writeUInt32BE(32, 24);
  header.writeUInt32BE(30, 28);
  return Buffer.concat([header, payload]);
}

function hello(details = { protocol: 2 }) {
  return wireRecord(2, Buffer.from(JSON.stringify(details)));
}

async function runRecord(args, onConnection) {
  const directory = await mkdtemp(join(tmpdir(), "capture-cli-"));
  const path = join(directory, "agent.sock");
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    onConnection(socket);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    const child = Bun.spawn(
      ["node", cli, "record", "--socket", path, "--output", join(directory, "out.h264"), ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { status, stderr };
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test.each(["0", "-1", "NaN", "Infinity", "1e20"])(
  "record rejects invalid seconds %s",
  async (value) => {
    const result = await runRecord([`--seconds=${value}`], () => {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--seconds must be positive");
  },
);

test("record reports an output failure", async () => {
  const result = await runRecord(["--output", "/dev/null/out.h264"], (socket) => {
    socket.write(hello());
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("recording output:");
});

test("record fails when the agent closes before the requested duration", async () => {
  const result = await runRecord([], (socket) => {
    socket.write(hello());
    socket.once("data", () => socket.end());
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("closed before recording finished");
});

test("record reports the agent's encoder failure", async () => {
  const result = await runRecord([], (socket) =>
    socket.write(hello({ encoderError: "install x264" })),
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("install x264");
});

test("record finishes a requested duration without an early-close error", async () => {
  const result = await runRecord(["--seconds", "0.2"], (socket) => {
    socket.write(hello());
    socket.once("data", () => socket.write(wireRecord(1, Buffer.from([0, 0, 0, 1, 0x65, 0x88]))));
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});

test("record fails instead of reporting an empty capture as successful", async () => {
  const result = await runRecord(["--seconds", "0.1"], (socket) => socket.write(hello()));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("no video frames");
});
