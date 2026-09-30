import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

import type { CrashDetailResponse } from "../crash/protocol";
import type { CrashMeta } from "../crash/runtime";
import type { CrashSummary } from "../crash/store";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync } from "./helpers";

const APP_NAME = "ServeSimSeededCrash";
const BUNDLE_ID = "dev.expo.serve-sim.seeded-crash";
const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const REPORTS_DIR = join(homedir(), "Library/Logs/DiagnosticReports");

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
    `Timed out after ${timeoutMs}ms waiting for ${description}. ` +
      "Inspect the serve-sim output and macOS DiagnosticReports directory.",
  );
}

function seedReport(udid: string, pid: number, capturedAt: string): string {
  const incidentId = randomUUID();
  const appPath = join(
    homedir(), "Library/Developer/CoreSimulator/Devices", udid,
    "data/Containers/Bundle/Application", incidentId, `${APP_NAME}.app`, APP_NAME,
  );
  const header = {
    app_name: APP_NAME,
    timestamp: capturedAt,
    app_version: "1.0",
    build_version: "1",
    platform: 7,
    bundleID: BUNDLE_ID,
    bug_type: "309",
    incident_id: incidentId,
  };
  const body = {
    procName: APP_NAME,
    procPath: appPath,
    pid,
    captureTime: capturedAt,
    exception: { type: "EXC_CRASH", signal: "SIGABRT" },
    termination: { indicator: "Abort trap: 6" },
    faultingThread: 0,
    usedImages: [{ name: APP_NAME, path: appPath }],
    threads: [{ frames: [{ imageIndex: 0, imageOffset: 1234, symbol: "crashFixtureAbort" }] }],
  };
  const name = `${APP_NAME}-${incidentId}.ips`;
  const temporaryPath = join(REPORTS_DIR, `.${name}`);
  const reportPath = join(REPORTS_DIR, name);
  // ReportCrash writes a hidden temporary file, then renames it when complete.
  writeFileSync(temporaryPath, `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`);
  renameSync(temporaryPath, reportPath);
  return reportPath;
}

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI);

requireE2E("seeded crash ingestion", ready);

describe.skipIf(!ready)("crash ingestion (seeded reports and built CLI)", () => {
  let server: ChildProcess | null = null;
  let tempDir = "";
  let baseUrl = "";
  const seededReports: string[] = [];

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "serve-sim-crash-e2e-"));

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
    for (const path of seededReports) rmSync(path, { force: true });
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("ingests, groups, and serves seeded crash reports", async () => {
    // Reading once starts the real DiagnosticReports watcher before seeding.
    const initial = await fetch(`${baseUrl}/crashes?device=${encodeURIComponent(udid!)}`);
    expect(initial.status).toBe(200);

    const firstPid = 10001;
    seededReports.push(seedReport(udid!, firstPid, new Date().toISOString()));

    const crash = await waitFor<CrashSummary>(async () => {
      const response = await fetch(`${baseUrl}/crashes?device=${encodeURIComponent(udid!)}`);
      if (!response.ok) return null;
      const payload = (await response.json()) as { meta: CrashMeta; crashes: CrashSummary[] };
      expect(payload.meta.status).toBe("watching");
      return payload.crashes.find(
        (record) => record.bundleId === BUNDLE_ID && record.pid === firstPid,
      ) ?? null;
    }, 60_000, "the watcher to ingest the first seeded .ips file");

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

    const secondPid = 10002;
    seededReports.push(seedReport(udid!, secondPid, new Date((crash.capturedAtMs ?? Date.now()) + 1000).toISOString()));

    const recurred = await waitFor<CrashSummary>(async () => {
      const response = await fetch(`${baseUrl}/crashes?device=${encodeURIComponent(udid!)}`);
      if (!response.ok) return null;
      const payload = (await response.json()) as { crashes: CrashSummary[] };
      return payload.crashes.find(
        (record) => record.id === crash.id && record.pid === secondPid && record.count === 2,
      ) ?? null;
    }, 60_000, "the watcher to ingest and group the fixture's second .ips file");

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
