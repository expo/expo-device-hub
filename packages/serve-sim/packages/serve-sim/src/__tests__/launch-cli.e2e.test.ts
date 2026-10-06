import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readLaunchState } from "../launch-state";
import { parseDetachState } from "./detach-state";
import { freePortAsync, killHelpersForDevice } from "./helpers";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";


const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const INSTALL_APP = "dev.expo.serve-sim.install-fixture";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);

requireE2E("serve-sim launch flags", ready);

let server: ChildProcess | undefined;
let installFixtureDirectory: string | undefined;

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function fixtureLines(bundleId = APP): string[] {
  try {
    const container = simctl(["get_app_container", udid!, bundleId, "data"]).trim();
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
  try { simctl(["uninstall", udid!, INSTALL_APP]); } catch {}
  installFixtureDirectory = mkdtempSync(join(tmpdir(), "serve-sim-install-fixture-"));
  const app = join(installFixtureDirectory, "Installed.app");
  cpSync(FIXTURE, app, { recursive: true });
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", INSTALL_APP, join(app, "Info.plist")]);
  execFileSync("plutil", ["-remove", "CFBundleURLTypes", join(app, "Info.plist")]);
  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
}, 120_000);

afterAll(() => {
  if (!ready) return;
  server?.kill("SIGKILL");
  // The helper outlives serve-sim on purpose, so this file has to stop it.
  killHelpersForDevice(udid!);
  try { simctl(["spawn", udid!, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"]); } catch {}
  try { simctl(["terminate", udid!, APP]); } catch {}
  try { simctl(["uninstall", udid!, APP]); } catch {}
  try { simctl(["uninstall", udid!, INSTALL_APP]); } catch {}
  if (installFixtureDirectory) rmSync(installFixtureDirectory, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!ready)("serve-sim launch flags", () => {
  test("installs and launches the app with its arguments and URL, then disarms on shutdown", async () => {
    expect(() => simctl(["get_app_container", udid!, APP])).toThrow();
    const port = await freePortAsync();
    server = spawn(
      "node",
      [
        CLI,
        udid!,
        "--port", String(port),
        "--no-preview",
        "--install-app-path", FIXTURE,
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

  test.each([undefined, APP])("installs an app independently of launch=%s", async (bundleId) => {
    killHelpersForDevice(udid!);
    try { simctl(["terminate", udid!, APP]); } catch {}
    try { simctl(["uninstall", udid!, INSTALL_APP]); } catch {}
    if (bundleId) simctl(["install", udid!, FIXTURE]);
    const previousLaunches = fixtureLines().filter((line) => line.startsWith("launch\t")).length;
    const port = await freePortAsync();
    server = spawn("node", [
      CLI, udid!, "--host", "127.0.0.1", "--port", String(port), "--quiet",
      "--install-app-path", join(installFixtureDirectory!, "Installed.app"),
      ...(bundleId ? ["--launch-app-identifier", bundleId, "--launch-arg", "-IndependentInstall"] : []),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    server.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      const readyLine = `"port":${port}`;
      await waitFor(() => stdout.includes(readyLine) || server?.exitCode !== null, 90_000);
      expect(stdout, `serve-sim did not become ready:\n${stderr}`).toContain(readyLine);
      expect(simctl(["get_app_container", udid!, INSTALL_APP]).trim()).not.toBe("");
      expect(fixtureLines(INSTALL_APP)).toEqual([]);
      const launches = fixtureLines().filter((line) => line.startsWith("launch\t"));
      expect(launches).toHaveLength(previousLaunches + (bundleId ? 1 : 0));
      if (bundleId) expect(launches.at(-1)?.split("\t")[2]).toBe("-IndependentInstall");
    } finally {
      server.kill("SIGTERM");
      expect(await waitFor(() => server?.exitCode !== null || server?.signalCode !== null, 30_000)).toBe(true);
      expect(await waitFor(() => readInsert(udid!) === "", 30_000)).toBe(true);
      try { simctl(["uninstall", udid!, INSTALL_APP]); } catch {}
    }
  }, 180_000);

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

  test("a detached helper does not set up the clipboard reader when its preview opens", async () => {
    spawnSync("node", [CLI, "--kill", udid!], { stdio: "ignore", timeout: 60_000 });
    const port = await freePortAsync();
    const detach = spawnSync("node", [CLI, "--detach", "-p", String(port), udid!], {
      encoding: "utf-8",
      timeout: 180_000,
    });
    expect(detach.status, `serve-sim --detach failed:\n${detach.stdout}\n${detach.stderr}`).toBe(0);
    const { url } = parseDetachState<{ url: string }>(detach.stdout);
    try {
      for (const path of ["/", "/api"]) {
        expect((await fetch(new URL(path, url))).status).toBe(200);
      }
      // The preview starts its setup in the background; give it time to arm if it would.
      await new Promise((r) => setTimeout(r, 3000));
      expect(readInsert(udid!)).toBe("");
      expect(readLaunchState(udid!)?.capabilities.clipboard).toBeUndefined();
    } finally {
      spawnSync("node", [CLI, "--kill", udid!], { stdio: "ignore", timeout: 60_000 });
    }
  }, 240_000);
});
