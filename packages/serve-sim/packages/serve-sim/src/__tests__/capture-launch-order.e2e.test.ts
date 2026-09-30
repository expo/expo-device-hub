// Verify the CLI captures requests from the app’s first launch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { createServer, type Server } from "http";
import { join } from "path";

import { locateMitmdump } from "../capture/mitm-engine";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimLaunchFixture.app");
const DYLIB = join(PKG_DIR, "dist/simnet/libSimNetProxy.dylib");
const APP = "dev.expo.serve-sim.launch-fixture";
const PATH_MARKER = "/capture-launch-order";

const udid = e2eDevice();
const ready =
  udid !== null
  && existsSync(CLI)
  && existsSync(FIXTURE)
  && existsSync(DYLIB)
  && locateMitmdump() !== null;
requireE2E("capture arms before launch", ready);

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(250);
  expect(check()).toBe(true);
}

const describeOrSkip = ready ? describe : describe.skip;

describeOrSkip("capture arms before launch", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let server: ChildProcess | null = null;
  let origin: Server | undefined;
  let originUrl = "";
  let stdout = "";
  let stderr = "";
  let port = 0;
  let served = 0;

  beforeAll(async () => {
    tempState = useTempStateDir();
    killHelpersForDevice(udid!);
    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
    simctl(["install", udid!, FIXTURE]);

    const originPort = await freePortAsync();
    origin = createServer((_req, res) => {
      served += 1;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("captured\n");
    });
    await new Promise<void>((done) => origin!.listen(originPort, "127.0.0.1", done));
    originUrl = `http://127.0.0.1:${originPort}${PATH_MARKER}`;

    port = await freePortAsync();
    server = spawn(
      "node",
      [
        CLI,
        "--network-capture",
        "--enable",
        "networkCapture",
        "--quiet",
        "--port",
        String(port),
        "--launch-app-identifier",
        APP,
        "--launch-arg",
        "-ServeSimFixtureRequest",
        "--launch-arg",
        originUrl,
        udid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    server.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
  }, 180_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          server?.kill("SIGKILL");
          done();
        }, 30_000);
        server!.on("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    try {
      try {
        simctl(["terminate", udid!, APP]);
      } catch {}
      try {
        simctl(["uninstall", udid!, APP]);
      } catch {}
      if (origin) {
        origin.closeAllConnections();
        await new Promise<void>((done) => origin!.close(() => done()));
      }
      // Asserted last, so a device left injected still gets the app and the origin cleaned up first.
      expect(readInsert(udid!)).toBe("");
    } finally {
      tempState.restore();
    }
  }, 180_000);

  test("records the request made by the app the CLI launched", async () => {
    await waitFor(() => served > 0);
    // Written once the preview server is bound, which is after the launch this test is about.
    const statePath = join(tempState.dir, `server-${udid!}.json`);
    await waitFor(() => existsSync(statePath));

    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { token?: string };
    // `capture har` reads this file; without a token it cannot reach the gated capture routes.
    expect(typeof state.token).toBe("string");

    const har = await fetch(`http://127.0.0.1:${port}/network-capture.har?device=${udid!}`, {
      headers: { Authorization: `Bearer ${state.token}`, Origin: `http://127.0.0.1:${port}` },
    });
    expect(har.status).toBe(200);
    const entries = ((await har.json()) as { log: { entries: { request: { url: string } }[] } }).log
      .entries;
    expect(entries.some((entry) => entry.request.url.includes(PATH_MARKER))).toBe(true);
  }, 180_000);

  test("keeps stdout to the JSON payload --quiet promises", () => {
    // An empty stdout would make the loop below vacuous.
    expect(stdout.trim().length).toBeGreaterThan(0);
    for (const line of stdout.split("\n").filter((line) => line.trim().length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(stderr).not.toContain("Network capture could not start");
  });
});
