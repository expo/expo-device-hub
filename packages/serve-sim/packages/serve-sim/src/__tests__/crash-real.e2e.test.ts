import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

import type { CrashDetailResponse } from "../crash/protocol";
import { parseCrashReport } from "../crash/report";
import type { CrashMeta } from "../crash/runtime";
import type { CrashSummary } from "../crash/store";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync } from "./helpers";

const APP_NAME = "ServeSimCrashFixture";
const BUNDLE_ID = "dev.expo.serve-sim.crash-fixture";
const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimCrashFixture.app");

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}. Verify the simulator is still ` +
      "booted, then inspect the serve-sim output and macOS DiagnosticReports directory.",
  );
}

function launchFixture(udid: string): number {
  const output = execFileSync(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", udid, BUNDLE_ID],
    { encoding: "utf8" },
  );
  const pid = Number(output.trim().match(/:\s*(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(pid)) {
    throw new Error(`simctl launched ${BUNDLE_ID} but did not report a process id: ${output.trim()}`);
  }
  return pid;
}

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);

requireE2E("real crash ingestion", ready);

describe.skipIf(!ready)("crash ingestion (real simulator app and built CLI)", () => {
  let server: ChildProcess | null = null;
  let tempDir = "";
  let baseUrl = "";
  let startedAt = 0;
  const launchedPids: number[] = [];

  beforeAll(async () => {
    startedAt = Date.now();
    tempDir = mkdtempSync(join(tmpdir(), "serve-sim-crash-e2e-"));
    spawnSync("xcrun", ["simctl", "uninstall", udid!, BUNDLE_ID], { stdio: "ignore" });
    execFileSync("xcrun", ["simctl", "install", udid!, FIXTURE], { stdio: "pipe" });

    const port = await freePortAsync();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("node", [CLI, "--port", String(port), udid!], {
      env: { ...process.env, SERVE_SIM_STATE_DIR: join(tempDir, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/healthz`)).ok ? true : null;
      } catch {
        return null;
      }
    }, 60_000, "the built serve-sim preview to become healthy");
  }, 120_000);

  afterAll(() => {
    server?.kill("SIGKILL");
    spawnSync("xcrun", ["simctl", "uninstall", udid!, BUNDLE_ID], { stdio: "ignore" });
    const reportsDir = join(homedir(), "Library/Logs/DiagnosticReports");
    for (const dir of [reportsDir, join(reportsDir, "Retired")]) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {}
      for (const name of names) {
        if (!name.startsWith(`${APP_NAME}-`)) continue;
        const path = join(dir, name);
        try {
          if (statSync(path).mtimeMs < startedAt) continue;
          const pid = parseCrashReport(readFileSync(path, "utf8"))?.pid;
          if (typeof pid === "number" && launchedPids.includes(pid)) rmSync(path, { force: true });
        } catch {}
      }
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("ingests, groups, and serves OS-written crash reports", async () => {
    // Reading once starts the real DiagnosticReports watcher before the app exits.
    const initial = await fetch(`${baseUrl}/crashes?device=${encodeURIComponent(udid!)}`);
    expect(initial.status).toBe(200);

    const firstPid = launchFixture(udid!);
    launchedPids.push(firstPid);

    const crash = await waitFor<CrashSummary>(async () => {
      const response = await fetch(`${baseUrl}/crashes?device=${encodeURIComponent(udid!)}`);
      if (!response.ok) return null;
      const payload = (await response.json()) as { meta: CrashMeta; crashes: CrashSummary[] };
      expect(payload.meta.status).toBe("watching");
      return payload.crashes.find(
        (record) => record.bundleId === BUNDLE_ID && record.pid === firstPid,
      ) ?? null;
    }, 60_000, "ReportCrash to publish the fixture's first .ips file");

    expect(crash).toMatchObject({
      appName: APP_NAME,
      bundleId: BUNDLE_ID,
      signal: "SIGABRT",
      count: 1,
      occurrenceCount: 1,
    });
    expect(crash.culpritFrame).toContain(APP_NAME);

    const detailResponse = await fetch(
      `${baseUrl}/crashes/${encodeURIComponent(crash.id)}?device=${encodeURIComponent(udid!)}`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as CrashDetailResponse;

    expect(detail.occurrence).toMatchObject({ pid: firstPid, index: 0, total: 1 });
    expect(detail.occurrence.frames.some((frame) => frame.appOwned)).toBe(true);
    expect(detail.report).toContain(BUNDLE_ID);
    expect(detail.report).toContain(udid!);
    expect(detail.reportError).toBeNull();

    const secondPid = launchFixture(udid!);
    launchedPids.push(secondPid);
    const recurred = await waitFor<CrashSummary>(async () => {
      const response = await fetch(`${baseUrl}/crashes?device=${encodeURIComponent(udid!)}`);
      if (!response.ok) return null;
      const payload = (await response.json()) as { crashes: CrashSummary[] };
      return payload.crashes.find(
        (record) => record.id === crash.id && record.pid === secondPid && record.count === 2,
      ) ?? null;
    }, 60_000, "ReportCrash to publish and group the fixture's second .ips file");

    expect(recurred.occurrenceCount).toBe(2);
    const newestResponse = await fetch(
      `${baseUrl}/crashes/${encodeURIComponent(crash.id)}?device=${encodeURIComponent(udid!)}`,
    );
    const newest = (await newestResponse.json()) as CrashDetailResponse;
    expect(newest.occurrence).toMatchObject({ pid: secondPid, index: 1, total: 2 });

    const oldestResponse = await fetch(
      `${baseUrl}/crashes/${encodeURIComponent(crash.id)}` +
        `?device=${encodeURIComponent(udid!)}&occurrence=0`,
    );
    const oldest = (await oldestResponse.json()) as CrashDetailResponse;
    expect(oldest.occurrence).toMatchObject({ pid: firstPid, index: 0, total: 2 });
  }, 90_000);
});
