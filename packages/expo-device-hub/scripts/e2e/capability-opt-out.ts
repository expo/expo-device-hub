import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { HubState } from "../../src/server/cli/state-file";

const pinned = process.env.HUB_E2E_UDID;
assert(pinned || process.env.CI, "Set HUB_E2E_UDID to a dedicated, booted iOS Simulator");
const result = JSON.parse(
  execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
    encoding: "utf8",
    timeout: 30_000,
  }),
) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
const booted = Object.entries(result.devices)
  .filter(([runtime]) => runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"))
  .flatMap(([runtime, devices]) =>
    devices.filter((device) => device.state === "Booted").map((device) => ({ ...device, runtime })),
  );
if (!pinned) assert.equal(booted.length, 1, "Expected one booted iOS Simulator for the Hub test");
const device = pinned ? booted.find(({ udid }) => udid === pinned) : booted[0];
assert(device, "The selected iOS Simulator is not booted");
const state = await mkdtemp(join(tmpdir(), "hub-capability-opt-out-"));
const hubStateDir = join(state, "hub");
const hub = Bun.spawn(
  [
    "node",
    resolve(import.meta.dir, "../../dist/server/cli.mjs"),
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--platform",
    "ios",
    "--single-device",
    device.udid,
    "--require-token",
    "--disable",
    "clipboard",
    "--disable",
    "keychain",
  ],
  {
    env: {
      ...process.env,
      EXPO_DEVICE_HUB_STATE_DIR: hubStateDir,
      SERVE_SIM_STATE_DIR: join(state, "serve-sim"),
      SERVE_SIM_CAPTURE_CA_DIR: join(state, "capture-ca"),
      // Exercise the fallback decision without relying on pbpaste to fail on a given iOS runtime.
      SERVE_SIM_SKIP_PBPASTE: "1",
    },
    stdout: "ignore", // The CLI prints its session token.
    stderr: "inherit",
  },
);

async function waitForHub(): Promise<HubState> {
  const deadline = Date.now() + 20_000;
  while (hub.exitCode === null && Date.now() < deadline) {
    const files = await readdir(hubStateDir).catch(() => []);
    const file = files.find((name) => name.endsWith(".json"));
    if (file) return JSON.parse(await readFile(join(hubStateDir, file), "utf8")) as HubState;
    await delay(50);
  }
  throw new Error(`Hub did not publish its state (exit code: ${hub.exitCode})`);
}

const clipboardError = "Clipboard reader is off on this server, by --disable clipboard.";
const keychainError = "The keychain capability is off on this server.";
type Reply = { id: number; exitCode: number; stderr: string };
let socket: WebSocket | undefined;
try {
  const { url, token } = await waitForHub();
  assert(token, "The Hub did not publish an authentication token");
  const preview = new URL("/vendor/serve-sim/", url);
  const http = await fetch(new URL("api/pasteboard", preview), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: preview.origin },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(http.status, 503);
  assert.deepEqual(await http.json(), { ok: false, error: clipboardError });
  console.log("Hub --disable clipboard: HTTP refused the app reader");

  const controls = new URL("exec-ws", preview);
  controls.protocol = "ws:";
  const connection = new WebSocket(controls, `serve-sim.token.${token}`);
  socket = connection;
  const responses = new Promise<Map<number, Reply>>((resolve, reject) => {
    const replies = new Map<number, Reply>();
    connection.once("error", reject);
    connection.once("close", () => reject(new Error("The Controls socket closed")));
    connection.on("message", (data) => {
      const reply = JSON.parse(data.toString()) as Reply;
      if (reply.id !== 1 && reply.id !== 2) return;
      replies.set(reply.id, reply);
      if (replies.size === 2) resolve(replies);
    });
    connection.once("open", () => {
      connection.send(JSON.stringify({ id: 1, action: "clipboard.read" }));
      connection.send(
        JSON.stringify({
          id: 2,
          action: "keychain.list",
          params: { bundleId: "dev.expo.serve-sim.launch-fixture" },
        }),
      );
    });
  });
  const replies = await Promise.race([responses, delay(10_000, null, { ref: false })]);
  assert(replies, "Timed out waiting for the Hub Controls replies");
  assert.equal(replies.get(1)?.exitCode, 1);
  assert.equal(replies.get(1)?.stderr, clipboardError);
  assert.equal(replies.get(2)?.exitCode, 1);
  assert.equal(replies.get(2)?.stderr, keychainError);
  console.log("Hub --disable clipboard: Controls refused the app reader");
  console.log("Hub --disable keychain: Controls refused Keychain listing");
  console.log(`Passed on ${device.name} (${device.runtime}, ${device.udid})`);
} finally {
  socket?.terminate();
  hub.kill("SIGTERM");
  await Promise.race([hub.exited, delay(5_000, null, { ref: false })]);
  if (hub.exitCode === null) hub.kill("SIGKILL");
  await hub.exited;
  await rm(state, { recursive: true, force: true });
}
