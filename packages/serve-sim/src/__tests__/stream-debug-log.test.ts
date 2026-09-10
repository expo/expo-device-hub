import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runStreamDebugLog, startStreamDebugLog } from "../stream-debug-log";

const dirs: string[] = [];

function logPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "stream-debug-"));
  dirs.push(dir);
  return join(dir, "stream.ndjson");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("startStreamDebugLog", () => {
  test("writes nothing while no session is streaming yet", async () => {
    const path = logPath();
    const logger = startStreamDebugLog({
      path,
      statsUrl: () => "http://127.0.0.1/stats",
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      now: () => "2026-01-01T00:00:00.000Z",
    });

    await logger.sample("A");

    expect(existsSync(path)).toBe(false);
  });

  test("writes one json line per sample, tagged with the device and a timestamp", async () => {
    const path = logPath();
    const logger = startStreamDebugLog({
      path,
      statsUrl: (device) => `http://x/helper/${device}/webrtc/stats`,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [{ qualityLimitationReason: "cpu" }] }),
      }),
      now: () => "2026-08-21T00:00:00.000Z",
    });

    await logger.sample("UDID-1");
    await logger.sample("UDID-1");

    const written = lines(path);
    expect(written).toHaveLength(2);
    expect(written[0]!.device).toBe("UDID-1");
    expect(written[0]!.at).toBe("2026-08-21T00:00:00.000Z");
    expect(written[0]!.stats).toEqual({ sessions: [{ qualityLimitationReason: "cpu" }] });
  });

  test("records the failure instead of dropping the sample, so a gap is explained", async () => {
    const path = logPath();
    const logger = startStreamDebugLog({
      path,
      statsUrl: () => "http://x",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    await logger.sample("UDID-1");

    expect(lines(path)[0]!.error).toBe("connection refused");
  });

  test("keeps the status when the route refuses, rather than logging an empty sample", async () => {
    const path = logPath();
    const logger = startStreamDebugLog({
      path,
      statsUrl: () => "http://x",
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => null }),
    });

    await logger.sample("UDID-1");

    const written = lines(path)[0]!;
    expect(written.status).toBe(503);
    expect(written.stats).toBeNull();
  });

  test("warns once when the file cannot be written, not once a second", async () => {
    const warnings: string[] = [];
    const logger = startStreamDebugLog({
      path: join(logPath(), "not-a-directory", "stream.ndjson"),
      statsUrl: () => "http://x",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      onError: (message) => warnings.push(message),
    });

    await logger.sample("UDID-1");
    await logger.sample("UDID-1");

    expect(warnings).toHaveLength(1);
  });
});

describe("runStreamDebugLog", () => {
  test("samples every device on each tick and stops when told", async () => {
    const sampled: string[] = [];
    const stop = runStreamDebugLog(
      ["A", "B"],
      { sample: async (device) => void sampled.push(device) },
      5,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    const afterStop = sampled.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sampled).toContain("A");
    expect(sampled).toContain("B");
    expect(sampled.length).toBe(afterStop);
  });
});
