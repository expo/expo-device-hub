import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { onCliInputReady } from "../socket/cli-input";

const CLI = join(import.meta.dir, "../index.ts");

const commands = [
  { args: ["tap", "0.5", "0.5"], messages: [0x03, 0x03, 0x11] },
  { args: ["gesture", '{"type":"begin","x":0.5,"y":0.5}'], messages: [0x03] },
  // Older helpers cannot check a button, so the CLI keeps their timed close.
  { args: ["button", "home"], messages: [0x04, 0x11], legacyMessages: [0x04] },
  { args: ["rotate", "portrait"], messages: [0x07] },
  { args: ["ca-debug", "blended", "on"], messages: [0x08] },
  { args: ["memory-warning"], messages: [0x09] },
  { args: ["software-keyboard"], messages: [0x0c] },
];

type InputTarget = {
  argument: string;
  devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
  liveDevices: string[];
};

async function runInput(
  args: string[],
  admit: boolean,
  legacy = false,
  target?: InputTarget,
  barrierOk = true,
  checkedButtons = !legacy,
) {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-cli-admission-"));
  const shim = join(dir, "bin");
  mkdirSync(shim);
  // The fake server has no simulator. Never inspect or drive a host device.
  writeFileSync(
    join(shim, "xcrun"),
    target
      ? `#!/bin/sh
case "$*" in
  "simctl list devices -j"|"simctl list devices booted -j")
    cat <<'DEVICES'
${JSON.stringify({ devices: target.devices })}
DEVICES
    ;;
  *) exit 1 ;;
esac
`
      : "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  const messages: number[] = [];
  const buttons: unknown[] = [];
  const connections: string[] = [];
  let admitted = false;
  let sentBeforeAdmission = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      connections.push(new URL(req.url).pathname);
      if (server.upgrade(req)) return;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(socket) {
        // Older helpers never send the admission frame.
        if (legacy) return;
        timers.push(
          setTimeout(() => {
            if (admit) {
              admitted = true;
              socket.send(Buffer.from([0x83]));
            } else
              socket.close(
                1013,
                "Simulator input unavailable; retry after other clients disconnect",
              );
          }, 200),
        );
      },
      message(socket, data) {
        if (!admitted) sentBeforeAdmission = true;
        const frame = Buffer.from(data);
        messages.push(frame[0]!);
        if (frame[0] === 0x04) buttons.push(JSON.parse(frame.subarray(1).toString()));
        if (frame[0] === 0x11) socket.send(Buffer.from([0x91, barrierOk ? 1 : 0]));
      },
    },
  });
  for (const device of target?.liveDevices ?? ["probe"]) {
    writeFileSync(
      join(dir, `server-${device}.json`),
      JSON.stringify({
        pid: process.pid,
        device,
        port: server.port,
        wsUrl: `ws://127.0.0.1:${server.port}/legacy/${device}/ws`,
        ...(legacy ? {} : { inputAdmission: true }),
        ...(checkedButtons ? { checkedButtons: true } : {}),
      }),
    );
  }
  try {
    const child = Bun.spawn([process.execPath, CLI, ...args, "-d", target?.argument ?? "probe"], {
      env: { ...process.env, SERVE_SIM_STATE_DIR: dir, PATH: `${shim}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return { exitCode, stderr, messages, buttons, sentBeforeAdmission, connections };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

const firstDevice = "00000000-0000-0000-0000-000000000001";
const secondDevice = "00000000-0000-0000-0000-000000000002";
const sameNameDevices = {
  "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
    { udid: firstDevice, name: "iPhone 17", state: "Booted" },
  ],
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
    { udid: secondDevice, name: "iPhone 17", state: "Booted" },
  ],
};

for (const legacy of [false, true]) {
  test(`CLI name lookup finds the only live stream across runtimes (${legacy ? "legacy" : "admitted"})`, async () => {
    const result = await runInput(["software-keyboard"], true, legacy, {
      argument: "iPhOnE 17",
      devices: sameNameDevices,
      liveDevices: [secondDevice],
    });
    expect(result.exitCode).toBe(0);
    expect(result.connections).toEqual([`/legacy/${secondDevice}/ws`]);
    expect(result.messages).toEqual([0x0c]);
    expect(result.sentBeforeAdmission).toBe(legacy);
  });
}

test("CLI name lookup rejects two live streams with the same name before connecting", async () => {
  const result = await runInput(["software-keyboard"], true, false, {
    argument: "iPhone 17",
    devices: sameNameDevices,
    liveDevices: [firstDevice, secondDevice],
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Ambiguous streaming device");
  expect(result.stderr).toContain(firstDevice);
  expect(result.stderr).toContain(secondDevice);
  expect(result.stderr).toContain("--device");
  expect(result.connections).toEqual([]);
  expect(result.messages).toEqual([]);
});

test("CLI UDID lookup still selects an explicit device when live names are ambiguous", async () => {
  const result = await runInput(["software-keyboard"], true, false, {
    argument: secondDevice,
    devices: sameNameDevices,
    liveDevices: [firstDevice, secondDevice],
  });
  expect(result.exitCode).toBe(0);
  expect(result.connections).toEqual([`/legacy/${secondDevice}/ws`]);
  expect(result.messages).toEqual([0x0c]);
});

test("CLI name lookup still selects a unique name case-insensitively", async () => {
  const result = await runInput(["software-keyboard"], true, false, {
    argument: "IPHONE 17",
    devices: { iOS: [{ udid: firstDevice, name: "iPhone 17", state: "Booted" }] },
    liveDevices: [firstDevice],
  });
  expect(result.exitCode).toBe(0);
  expect(result.connections).toEqual([`/legacy/${firstDevice}/ws`]);
  expect(result.messages).toEqual([0x0c]);
});

for (const { args, messages, legacyMessages } of commands) {
  if (args[0] !== "software-keyboard") {
    test(`CLI ${args[0]} routes a simulator name to the only live stream across runtimes`, async () => {
      const result = await runInput(args, /* admit */ true, /* legacy */ false, {
        argument: "iPhOnE 17",
        devices: sameNameDevices,
        liveDevices: [secondDevice],
      });
      expect(result.exitCode).toBe(0);
      expect(result.connections).toEqual([`/legacy/${secondDevice}/ws`]);
      expect(result.sentBeforeAdmission).toBe(false);
      expect(result.messages).toEqual(messages);
    });
  }

  test(`CLI ${args[0]} rejects a full input pool even when refusal arrives after its old success timer`, async () => {
    const result = await runInput(args, /* admit */ false);
    expect(result.exitCode).not.toBe(0);
    // Bun prints source excerpts too; only the actual error line proves the refusal.
    expect(result.stderr).toMatch(
      /^error: Simulator input rejected: Simulator input unavailable; retry after other clients disconnect\. Try again shortly\.$/m,
    );
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
    expect(result.messages).toEqual(legacyMessages ?? messages);
  });
}

test("CLI button asks for a checked send and exits non-zero when the barrier reports failure", async () => {
  const result = await runInput(["button", "lock"], /* admit */ true, false, undefined, false);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/^error: Simulator button input failed\./m);
  expect(result.messages).toEqual([0x04, 0x11]);
  expect(result.buttons).toEqual([{ button: "lock", checked: true }]);
});

test("CLI button sends the HID code of a device-frame button with the checked flag", async () => {
  const result = await runInput(["button", "volume-up"], /* admit */ true);
  expect(result.exitCode).toBe(0);
  expect(result.buttons).toEqual([{ button: "volume-up", page: 12, usage: 233, checked: true }]);
});

for (const name of ["nonsense-button", "constructor", "toString"]) {
  test(`CLI button refuses the unknown name ${name} before connecting`, async () => {
    const result = await runInput(["button", name], /* admit */ true);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Unknown button "${name}"`);
    expect(result.stderr).toContain("lock");
    expect(result.connections).toEqual([]);
  });
}

test("CLI button on an admitted helper without checked buttons warns and keeps the old send", async () => {
  const result = await runInput(
    ["button", "lock"],
    /* admit */ true,
    /* legacy */ false,
    undefined,
    /* barrierOk */ false,
    /* checkedButtons */ false,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("cannot report button failures");
  expect(result.messages).toEqual([0x04]);
  expect(result.buttons).toEqual([{ button: "lock" }]);
});

test("an open transport without admission fails by the deadline and terminates", async () => {
  let terminated = false;
  let sent = false;
  const socket = Object.assign(new EventEmitter(), {
    terminate: () => {
      terminated = true;
    },
  });
  const error = await new Promise<Error>((resolve) => {
    onCliInputReady(
      socket as unknown as WebSocket,
      /* requireAdmission */ true,
      () => {
        sent = true;
      },
      resolve,
      10,
    );
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
  onCliInputReady(
    socket as unknown as WebSocket,
    /* requireAdmission */ true,
    () => {
      sent = true;
    },
    (error) => errors.push(error),
    10,
  );
  socket.emit("open");
  socket.emit("close", 1000, Buffer.from(""));
  expect(errors.map((error) => error.message)).toEqual([
    "Simulator input closed before admission (1000). Try again shortly.",
  ]);
  await Bun.sleep(25);
  expect(errors).toHaveLength(1);
  expect(sent).toBe(false);
});
