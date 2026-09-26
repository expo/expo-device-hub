import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseDetachState } from "./detach-state";
import { freePortAsync } from "./helpers";
import type { ServeSimDeviceState } from "../state";

// Covers a reboot through the preview's shutdown and start controls, which
// keep the server PID but open a new capture session. A plain `simctl` reboot
// behind a live session is a separate path and is not covered here.
// Explicit opt-in: this shuts down and reboots the pinned simulator. Run only
// on a dedicated iPhone Duo after building serve-sim and its launch fixture.
// SERVE_SIM_TEST_UDID=<Duo UDID> SERVE_SIM_DUO_REBOOT_E2E=1 bun run test:e2e -- \
//   packages/serve-sim/src/__tests__/duo-reboot-recovery.e2e.test.ts
const enabled = process.env.SERVE_SIM_DUO_REBOOT_E2E === "1";
const udid = process.env.SERVE_SIM_TEST_UDID?.trim();
const CLI = join(import.meta.dir, "../../dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";

function simctl(...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf8", stdio: "pipe", timeout: args[0] === "bootstatus" ? 180_000 : 60_000,
  });
}

function bootedDuo(device: string): boolean {
  const listing = JSON.parse(simctl("list", "devices", "booted", "-j")) as {
    devices: Record<string, { name: string; udid: string }[]>;
  };
  return Object.values(listing.devices).flat().some((sim) => sim.udid === device && sim.name.includes("iPhone Duo"));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(message);
}

async function gridPost(serverUrl: string, action: "shutdown" | "start", device: string): Promise<void> {
  const response = await fetch(`${serverUrl}/grid/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ udid: device }),
    signal: AbortSignal.timeout(action === "start" ? 190_000 : 35_000),
  });
  if (!response.ok) throw new Error(`grid ${action} failed: ${response.status} ${await response.text()}`);
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function completeJpegs(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let from = 0;
  for (;;) {
    const start = data.indexOf(SOI, from);
    if (start < 0) break;
    const end = data.indexOf(EOI, start + 2);
    if (end < 0) break;
    frames.push(data.subarray(start, end + 2));
    from = end + 2;
  }
  return frames;
}

/** The second complete JPEG, so a live stream is proven to move past its first part. */
async function readJpegFrame(url: string): Promise<Buffer> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`MJPEG unavailable: ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes < 8_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      bytes += value.length;
      const frames = completeJpegs(Buffer.concat(chunks));
      if (frames.length >= 2) return Buffer.from(frames[1]!);
    }
    throw new Error("MJPEG stopped before two JPEG frames");
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}

test.skipIf(!enabled)("Duo main capture and HID recover after a preview reboot in the same server PID", async () => {
  if (!udid) throw new Error("set SERVE_SIM_TEST_UDID to the dedicated iPhone Duo UDID");
  if (!bootedDuo(udid)) throw new Error(`${udid} must be a booted iPhone Duo`);
  expect(existsSync(CLI), "build serve-sim first").toBe(true);
  expect(existsSync(FIXTURE), "build the launch fixture first").toBe(true);

  const stateDir = mkdtempSync(join(tmpdir(), "serve-sim-duo-reboot-"));
  const env = { ...process.env, SERVE_SIM_STATE_DIR: stateDir, SERVE_SIM_DEBUG_HID: "1" };
  const cli = (...args: string[]) => execFileSync("node", [CLI, ...args], {
    env, encoding: "utf8", stdio: "pipe", timeout: 120_000,
  });
  let fixtureLog = "";
  const lines = () => {
    try { return readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  };
  try {
    simctl("install", udid, FIXTURE);
    fixtureLog = join(simctl("get_app_container", udid, APP, "data").trim(), "Documents/launches.tsv");
    const launchFixture = async () => {
      const start = lines().length;
      try { simctl("terminate", udid, APP); } catch {}
      simctl("launch", udid, APP, "--input-test");
      await waitFor(() => lines().slice(start).some((line) => line.startsWith("input-ready\t")),
        30_000, "input fixture never reached the foreground");
    };
    const tapFixture = async (timeoutMs = 15_000) => {
      const start = lines().length;
      cli("tap", "0.5", "0.5", "-d", udid);
      await waitFor(() => {
        const fresh = lines().slice(start);
        return fresh.some((line) => line.startsWith("touch-began\t")) &&
          fresh.some((line) => line.startsWith("touch-ended\t"));
      }, timeoutMs, "serve-sim tap did not reach UIKit");
    };

    const port = await freePortAsync();
    const detach = spawnSync("node", [CLI, "--detach", "-p", String(port), udid], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
    if (detach.status !== 0) throw new Error(`serve-sim --detach failed: ${detach.stderr}`);
    const state = parseDetachState<ServeSimDeviceState>(detach.stdout);
    const pid = (JSON.parse(readFileSync(join(stateDir, `server-${udid}.json`), "utf8")) as ServeSimDeviceState).pid;
    const liveFrames = async (message: string) => waitFor(async () => {
      try { await readJpegFrame(state.streamUrl); return true; } catch { return false; }
    }, 90_000, message);

    await liveFrames("no live main MJPEG frames before reboot");
    await launchFixture();
    await tapFixture(); // Prime the old boot's HID capability before rebooting.

    // Reboot through the preview's own controls: shutdown closes the session,
    // and start boots the device so the next stream opens a fresh capture.
    await gridPost(state.url, "shutdown", udid);
    await gridPost(state.url, "start", udid);

    await liveFrames("main MJPEG did not recover after Duo reboot");
    const beforeLaunch = await readJpegFrame(state.streamUrl);
    await launchFixture();
    // A repeated cached frame, or a feed of the inactive panel, would keep
    // showing the image from before the fixture launched.
    await waitFor(async () => {
      try { return !(await readJpegFrame(state.streamUrl)).equals(beforeLaunch); } catch { return false; }
    }, 15_000, "main MJPEG did not show the fixture after Duo reboot");
    // CoreDevice can switch the active Duo display a few times after boot, and
    // iOS may drop a tap sent during that switch. Allow the first tap to
    // retry. With stale HID state, every tap is lost.
    for (let attempt = 1; ; attempt++) {
      try {
        await tapFixture(5_000);
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        await Bun.sleep(2_000);
      }
    }
    // Input must then stay live: each further tap must land on its first try.
    for (let i = 0; i < 3; i++) await tapFixture(5_000);
    expect((JSON.parse(readFileSync(join(stateDir, `server-${udid}.json`), "utf8")) as ServeSimDeviceState).pid).toBe(pid);
    process.kill(pid, 0);
  } catch (err) {
    // Keep the evidence that the finally block is about to delete.
    let serverLog = "";
    try { serverLog = readFileSync(join(stateDir, `server-${udid}.log`), "utf8"); } catch {}
    console.error(`--- server log (tail) ---\n${serverLog.split("\n").slice(-80).join("\n")}`);
    console.error(`--- fixture log (tail) ---\n${lines().slice(-20).join("\n")}`);
    throw err;
  } finally {
    try { cli("--kill", udid); } catch {}
    let booted = false;
    try { booted = bootedDuo(udid); } catch {}
    if (!booted) {
      try { simctl("boot", udid); simctl("bootstatus", udid, "-b"); } catch {}
    }
    try { simctl("terminate", udid, APP); } catch {}
    try { simctl("uninstall", udid, APP); } catch {}
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 360_000);
