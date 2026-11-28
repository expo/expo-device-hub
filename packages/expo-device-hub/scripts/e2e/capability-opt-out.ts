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
const { udid } = device;

function launchdEnv(name: string): string {
  return execFileSync("xcrun", ["simctl", "spawn", udid, "launchctl", "getenv", name], {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
}

async function waitForHub(hub: Bun.Subprocess, hubStateDir: string): Promise<HubState> {
  const deadline = Date.now() + 20_000;
  while (hub.exitCode === null && Date.now() < deadline) {
    const files = await readdir(hubStateDir).catch(() => []);
    const file = files.find((name) => name.endsWith(".json"));
    if (file) return JSON.parse(await readFile(join(hubStateDir, file), "utf8")) as HubState;
    await delay(50);
  }
  throw new Error(`Hub did not publish its state (exit code: ${hub.exitCode})`);
}

async function verifyHub(hubPackage: string, mode: "default" | "disabled"): Promise<void> {
  const disabled = mode === "disabled";
  const state = await mkdtemp(join(tmpdir(), "hub-capability-opt-out-"));
  const hubStateDir = join(state, "hub");
  const simStateDir = join(state, "serve-sim");
  const configPath = join(simStateDir, `capabilities-${udid}.conf`);
  const loaderConfig = () => launchdEnv("SERVE_SIM_CAPABILITIES_CONFIG");
  const hubInserts = () =>
    launchdEnv("DYLD_INSERT_LIBRARIES")
      .split(":")
      .filter((path) => path.startsWith(`${hubPackage}/`));
  const flags = disabled ? ["--disable", "clipboard", "--disable", "keychain"] : [];
  const hub = Bun.spawn(
    [
      "node",
      join(hubPackage, "dist/server/cli.mjs"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--platform",
      "ios",
      "--single-device",
      udid,
      "--require-token",
      ...flags,
    ],
    {
      env: {
        ...process.env,
        EXPO_DEVICE_HUB_STATE_DIR: hubStateDir,
        SERVE_SIM_STATE_DIR: simStateDir,
        SERVE_SIM_CAPTURE_CA_DIR: join(state, "capture-ca"),
        // Exercise the fallback decision without relying on pbpaste to fail on a given runtime.
        SERVE_SIM_SKIP_PBPASTE: "1",
      },
      stdout: "ignore", // The CLI prints its session token.
      stderr: "inherit",
    },
  );
  try {
    const { url, token } = await waitForHub(hub, hubStateDir);
    assert(token, "The Hub did not publish an authentication token");
    const preview = new URL("/vendor/serve-sim/", url);
    const headers = { Authorization: `Bearer ${token}`, Origin: preview.origin };
    // The device-start route waits for capability setup before it publishes the preview.
    const start = await fetch(new URL("grid/api/start", preview), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ udid }),
      signal: AbortSignal.timeout(120_000),
    });
    assert.deepEqual(await start.json(), { ok: true });
    const config = await fetch(new URL("api", preview), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(config.status, 200);
    const { device: previewDevice, keychain } = await config.json();
    assert.equal(previewDevice, udid);
    assert.equal(keychain, disabled ? undefined : true, "Unexpected Keychain availability");
    const launch = await readFile(join(simStateDir, `launch-${udid}.json`), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      },
    );
    const { capabilities } = JSON.parse(launch) as {
      capabilities?: Record<string, { ownerPid: number | null }>;
    };
    for (const name of ["clipboard", "keychain"]) {
      if (disabled) assert.equal(capabilities?.[name], undefined, `Registered disabled ${name}`);
      else
        assert.equal(capabilities?.[name]?.ownerPid, hub.pid, `Failed to register default ${name}`);
    }
    if (disabled) {
      assert.notEqual(loaderConfig(), configPath, "Disabled preview published a loader config");
      assert.deepEqual(hubInserts(), [], "Disabled preview inserted bundled libraries");
      console.log("Hub opt-outs: opening the preview did not register either helper");
      await verifyDisabledRequests(preview, token);
    } else {
      assert.equal(loaderConfig(), configPath, "Default preview did not publish its loader config");
      const loader = "vendor/serve-sim/dist/capability-loader/libServeSimCapabilityLoader.dylib";
      assert(
        hubInserts().includes(join(hubPackage, loader)),
        "Default preview did not insert its loader",
      );
      console.log("Hub defaults: opening the preview registered both helpers");
    }
  } finally {
    hub.kill("SIGTERM");
    // Allow the Hub's 60-second shutdown deadline to elapse before killing it.
    await Promise.race([hub.exited, delay(65_000, null, { ref: false })]);
    if (hub.exitCode === null) hub.kill("SIGKILL");
    await hub.exited;
    await rm(state, { recursive: true, force: true });
  }
  assert.equal(hub.exitCode, 0, "Hub did not exit cleanly");
  assert.notEqual(loaderConfig(), configPath, "Hub left its loader config after shutdown");
  assert.deepEqual(hubInserts(), [], "Hub left bundled libraries inserted after shutdown");
}

async function verifyDisabledRequests(preview: URL, token: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}`, Origin: preview.origin };
  const clipboardError = "Clipboard reader is off on this server, by --disable clipboard.";
  const keychainError = "The keychain capability is off on this server.";
  type Reply = { id: number; exitCode: number; stderr: string };
  let socket: WebSocket | undefined;
  try {
    const http = await fetch(new URL("api/pasteboard", preview), {
      method: "POST",
      headers,
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
  } finally {
    socket?.terminate();
  }
}

const hubRoot = resolve(import.meta.dir, "../..");
// Extract beneath the workspace package so Node resolves the existing locked dependencies.
const archiveDir = await mkdtemp(join(hubRoot, ".capability-opt-out-"));
try {
  const tarball = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", archiveDir, "--silent"],
    { cwd: hubRoot, encoding: "utf8", timeout: 60_000 },
  ).trim();
  execFileSync("tar", ["-xzf", join(archiveDir, tarball), "-C", archiveDir], { timeout: 60_000 });
  const hubPackage = join(archiveDir, "package");
  console.log(`Testing the Hub package from ${tarball}`);
  await verifyHub(hubPackage, "default");
  await verifyHub(hubPackage, "disabled");
} finally {
  await rm(archiveDir, { recursive: true, force: true });
}
console.log(`Passed on ${device.name} (${device.runtime}, ${device.udid})`);
