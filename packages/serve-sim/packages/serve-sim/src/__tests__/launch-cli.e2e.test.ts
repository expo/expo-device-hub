import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { cameraHelperPidFile } from "../camera-helper";
import { launchApp, readLaunchState, removeCapabilityLoaderSync } from "../launch-manager";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";


const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);

requireE2E("serve-sim launch flags", ready);

let server: ChildProcess | undefined;

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function fixtureLines(): string[] {
  try {
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    return readFileSync(join(container, "Documents/launches.tsv"), "utf-8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(() => {
  if (!ready) return;
  try { simctl(["spawn", udid!, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]); } catch {}
  try { simctl(["uninstall", udid!, APP]); } catch {}
  simctl(["install", udid!, FIXTURE]);
}, 120_000);

afterAll(() => {
  if (!ready) return;
  server?.kill("SIGKILL");
  // The helper outlives serve-sim on purpose, so this file has to stop it.
  killHelpersForDevice(udid!);
  try { simctl(["spawn", udid!, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]); } catch {}
  try { simctl(["terminate", udid!, APP]); } catch {}
  try { simctl(["uninstall", udid!, APP]); } catch {}
}, 120_000);

describe.skipIf(!ready)("serve-sim launch flags", () => {
  test("launches the app with its arguments and URL, then disarms on shutdown", async () => {
    const port = await freePortAsync();
    server = spawn(
      "node",
      [
        CLI,
        udid!,
        "--port", String(port),
        "--no-preview",
        "--enable", "camera",
        "--launch-app-identifier", APP,
        "--launch-arg", "-ServeSimCliFlag",
        "--launch-arg", "1",
        "--open-url", "serve-sim-fixture://from-cli",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    server.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const launched = await waitFor(
      () => fixtureLines().some((line) => line.startsWith("launch\t")),
      90_000,
    );
    expect(launched, `no launch recorded. serve-sim output:\n${output}`).toBe(true);

    const launch = fixtureLines().find((line) => line.startsWith("launch\t"));
    expect(launch?.split("\t")[2]).toBe("-ServeSimCliFlag\x1f1");

    expect(
      await waitFor(
        () => fixtureLines().some((line) => line.endsWith("serve-sim-fixture://from-cli")),
        60_000,
      ),
      `no URL recorded. serve-sim output:\n${output}`,
    ).toBe(true);

    expect(fixtureLines().filter((line) => line.startsWith("start\t"))).toHaveLength(1);

    // Whether serve-sim stays up or returns straight away depends on whether a
    // helper was already streaming this device, so only the teardown is asserted.
    server.kill("SIGTERM");
    const exited = await waitFor(
      () => server?.exitCode !== null || server?.signalCode !== null,
      30_000,
    );
    expect(exited, `serve-sim did not exit. output:\n${output}`).toBe(true);

    expect(
      await waitFor(() => readInsert(udid!) === "", 30_000),
      `insert still ${readInsert(udid!)} on ${udid}. exit=${server?.exitCode} ` +
        `signal=${server?.signalCode} output:\n${output}`,
    ).toBe(true);
  }, 240_000);

  test("exiting a session disconnects its default camera and stops its helper", async () => {
    const temp = useTempStateDir();
    const port = await freePortAsync();
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    let output = "";
    try {
      await launchApp(udid!, { bundleId: APP });
      const startsBefore = fixtureLines().filter((line) => line.startsWith("start\t"));
      server = spawn("node", [CLI, udid!, "--port", String(port), "--enable", "camera", "--quiet"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      server.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      expect(await waitFor(() =>
        !!readLaunchState(udid!)?.capabilities.camera?.ownerPids.includes(server?.pid ?? -1) &&
        existsSync(cameraHelperPidFile(udid!)) && output.includes('"url"'), 60_000), output).toBe(true);
      expect(fixtureLines().filter((line) => line.startsWith("start\t"))).toEqual(startsBefore);
      const helperPid = Number(readFileSync(cameraHelperPidFile(udid!), "utf-8"));
      expect(alive(helperPid)).toBe(true);
      server.kill("SIGTERM");
      expect(await waitFor(() => server?.exitCode !== null || server?.signalCode !== null, 30_000), output).toBe(true);
      expect(await waitFor(() => !alive(helperPid), 10_000), output).toBe(true);
      expect(existsSync(cameraHelperPidFile(udid!))).toBe(false);
      expect(readInsert(udid!)).toBe("");
    } finally {
      if (server?.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
      try {
        execFileSync("node", [CLI, "camera", "disable", "-d", udid!, "--quiet"], {
          // Bun's execFileSync ignores later process.env changes.
          stdio: "ignore", timeout: 60_000, env: process.env,
        });
      } finally {
        removeCapabilityLoaderSync(udid!);
        temp.restore();
      }
    }
  }, 150_000);

  test("a launch that fails does not leave the capability loader inserted", async () => {
    const port = await freePortAsync();
    const result = spawnSync(
      "node",
      [
        CLI,
        udid!,
        "--port", String(port),
        "--no-preview",
        "--launch-app-identifier", "dev.expo.serve-sim.not-installed",
      ],
      { encoding: "utf-8", timeout: 180_000 },
    );

    expect(result.status).toBe(1);
    expect(readInsert(udid!)).toBe("");
  }, 240_000);
});
