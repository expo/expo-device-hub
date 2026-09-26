// Verify a real HTTP request reaches capture; this does not test HTTPS decryption.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { createServer, type Server } from "http";
import { join } from "path";

import { captureRuntime } from "../capture";
import { releaseSessionSync } from "../launch-manager";
import { locateMitmdump } from "../capture/mitm-engine";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";

const PKG_DIR = join(import.meta.dir, "../..");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimLaunchFixture.app");
const DYLIB = join(PKG_DIR, "dist/simnet/libSimNetProxy.dylib");
const APP = "dev.expo.serve-sim.launch-fixture";
const PATH_MARKER = "/capture-e2e-marker";

const udid = e2eDevice();
const ready = udid !== null && existsSync(FIXTURE) && existsSync(DYLIB) && locateMitmdump() !== null;
requireE2E("capture request round trip", ready);

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(200);
  expect(check()).toBe(true);
}

const describeOrSkip = ready ? describe : describe.skip;

describeOrSkip("capture request round trip", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let origin: Server | undefined;
  let originUrl: string;
  let served = 0;

  beforeAll(async () => {
    tempState = useTempStateDir();
    // A device another run left capturing would decide this result instead of the test.
    killHelpersForDevice(udid!);
    await captureRuntime.disableForDevice(udid!).catch(() => {});

    const port = await freePortAsync();
    origin = createServer((_req, res) => {
      served += 1;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("captured\n");
    });
    await new Promise<void>((done) => origin!.listen(port, "127.0.0.1", done));
    originUrl = `http://127.0.0.1:${port}${PATH_MARKER}`;

    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
    simctl(["install", udid!, FIXTURE]);
  }, 120_000);

  afterAll(async () => {
    try {
      await captureRuntime.disableForDevice(udid!);
      releaseSessionSync(udid!, process.pid, () => {});
      // Swallowing this is how a device stays injected for every test that runs after it.
      expect(readInsert(udid!)).toBe("");
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
    } finally {
      tempState.restore();
    }
  }, 120_000);

  function settledMarker() {
    return (captureRuntime.storeFor(udid!)?.list() ?? []).filter(
      (request) => request.url.includes(PATH_MARKER) && request.status !== null,
    );
  }

  // Each row is kind, pid, detail; the test only cares what the app reported.
  function fixtureDetails(kind: string): string[] {
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    const path = join(container, "Documents/launches.tsv");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.startsWith(`${kind}\t`))
      .map((line) => line.split("\t").at(-1) ?? "");
  }

  test("records a request the app made through the capture proxy", async () => {
    const meta = await captureRuntime.enableForDevice(udid!);
    expect(meta.attachment).toBe("capturing");
    expect(meta.proxyAddress).not.toBeNull();

    simctl(["launch", udid!, APP, "-ServeSimFixtureRequest", originUrl]);

    // The origin proving it was reached rules out "the store is empty because nothing was sent".
    await waitFor(() => served > 0);
    await waitFor(() => settledMarker().length > 0);

    const captured = settledMarker();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.status).toBe(200);
    expect(fixtureDetails("request")).toEqual(["status=200 bytes=9"]);
  }, 60_000);
});
