import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { onCliInputReady } from "../socket/cli-input";

const CLI = join(import.meta.dir, "../index.ts");

const commands = [
  { args: ["tap", "0.5", "0.5"], messages: [0x03, 0x03] },
  { args: ["gesture", '{"type":"begin","x":0.5,"y":0.5}'], messages: [0x03] },
  { args: ["button", "home"], messages: [0x04] },
  { args: ["rotate", "portrait"], messages: [0x07] },
  { args: ["ca-debug", "blended", "on"], messages: [0x08] },
  { args: ["memory-warning"], messages: [0x09] },
];

async function runInput(args: string[], admit: boolean, legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-cli-admission-"));
  const shim = join(dir, "bin");
  mkdirSync(shim);
  // The fake server has no simulator. Never inspect or drive a host device.
  writeFileSync(join(shim, "xcrun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const messages: number[] = [];
  let admitted = false;
  let sentBeforeAdmission = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(socket) {
        // Older helpers never send the admission frame.
        if (legacy) return;
        timers.push(setTimeout(() => {
          if (admit) {
            admitted = true;
            socket.send(Buffer.from([0x83]));
          } else socket.close(1013, "Simulator input unavailable; retry after other clients disconnect");
        }, 200));
      },
      message(_socket, data) {
        if (!admitted) sentBeforeAdmission = true;
        messages.push(Buffer.from(data)[0]!);
      },
    },
  });
  writeFileSync(join(dir, "server-probe.json"), JSON.stringify({
    pid: process.pid, device: "probe", port: server.port,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    ...(legacy ? {} : { inputAdmission: true }),
  }));
  try {
    const child = Bun.spawn([process.execPath, CLI, ...args, "-d", "probe"], {
      env: { ...process.env, SERVE_SIM_STATE_DIR: dir, PATH: `${shim}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    return { exitCode, stderr, messages, sentBeforeAdmission };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const { args, messages } of commands) {
  test(`CLI ${args[0]} rejects a full input pool even when refusal arrives after its old success timer`, async () => {
    const result = await runInput(args, /* admit */ false);
    expect(result.exitCode).not.toBe(0);
    // Bun prints source excerpts too; only the actual error line proves the refusal.
    expect(result.stderr).toMatch(/^error: Simulator input rejected: Simulator input unavailable; retry after other clients disconnect\. Try again shortly\.$/m);
    expect(result.messages).toEqual([]);
  });

  test(`CLI ${args[0]} waits for admission before sending input`, async () => {
    const result = await runInput(args, /* admit */ true);
    expect(result.exitCode).toBe(0);
    expect(result.sentBeforeAdmission).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  test(`CLI ${args[0]} can still use a legacy helper without an admission frame`, async () => {
    const result = await runInput(args, /* admit */ true, /* legacy */ true);
    expect(result.exitCode).toBe(0);
    expect(result.sentBeforeAdmission).toBe(true);
    expect(result.messages).toEqual(messages);
  });
}

test("an open transport without admission fails by the deadline and terminates", async () => {
  let terminated = false;
  let sent = false;
  const socket = Object.assign(new EventEmitter(), { terminate: () => { terminated = true; } });
  const error = await new Promise<Error>(resolve => {
    onCliInputReady(socket as unknown as WebSocket, /* requireAdmission */ true, () => { sent = true; }, resolve, 10);
    socket.emit("open");
  });
  expect(error.message).toContain("Simulator input was not admitted within");
  expect(sent).toBe(false);
  expect(terminated).toBe(true);
});

test("a normal close before admission fails immediately and cancels the deadline", async () => {
  const errors: Error[] = [];
  let sent = false;
  const socket = Object.assign(new EventEmitter(), { terminate: () => {} });
  onCliInputReady(socket as unknown as WebSocket, /* requireAdmission */ true, () => { sent = true; }, error => errors.push(error), 10);
  socket.emit("open");
  socket.emit("close", 1000, Buffer.from(""));
  expect(errors.map(error => error.message)).toEqual(["Simulator input closed before admission (1000). Try again shortly."]);
  await Bun.sleep(25);
  expect(errors).toHaveLength(1);
  expect(sent).toBe(false);
});
