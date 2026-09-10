import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, execSync, spawnSync } from "child_process";
import { join } from "path";
import { parseDetachState } from "./detach-state";

/**
 * Integration test for the `/metrics` SSE endpoint.
 *
 * Skipped automatically when no iOS simulator is booted. On a booted sim it
 * exercises the route contract end-to-end: the `event: meta` frame is emitted
 * first (before any sample), and an unknown device is rejected with a 404. The
 * route's meta-ordering, 404, shared-sampler, and last-client-cleanup behavior
 * is unit-tested against a fake req/res in metrics-route.test.ts.
 */

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");

function firstBootedIosSim(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const device of devices) {
        if (device.state === "Booted") return device.udid;
      }
    }
  } catch {}
  return null;
}

const bootedUdid = firstBootedIosSim();
const describeOrSkip = bootedUdid ? describe : describe.skip;

describeOrSkip("/metrics endpoint (real simulator)", () => {
  let baseUrl: string;

  beforeAll(() => {
    try { execFileSync("bun", ["run", CLI_PATH, "--kill", bootedUdid!], { stdio: "pipe" }); } catch {}

    const startPort = 40_000 + Math.floor(Math.random() * 20_000);
    const detach = spawnSync("bun", ["run", CLI_PATH, "--detach", "-p", String(startPort), bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 45_000,
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(
        `serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\nstdout: ${detach.stdout ?? "<none>"}`,
      );
    }
    const state = parseDetachState<{ url: string }>(detach.stdout);
    baseUrl = state.url;
  }, 60_000);

  afterAll(() => {
    try { execFileSync("bun", ["run", CLI_PATH, "--kill", bootedUdid!], { stdio: "pipe" }); } catch {}
  }, 30_000);

  test("emits the meta frame before any sample", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${baseUrl}/metrics?device=${bootedUdid}`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Read until the first SSE `data:` payload arrives — it must be the meta frame
      // (schema, udid, cadence), ahead of any per-sample frame.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstPayload: Record<string, unknown> | undefined;
      while (!firstPayload) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice("data:".length).trim();
            if (payload) {
              firstPayload = JSON.parse(payload) as Record<string, unknown>;
              break;
            }
          }
        }
      }
      expect(firstPayload).toMatchObject({ schemaVersion: 1, udid: bootedUdid });
      expect("t" in firstPayload!).toBe(false); // meta, not a sample
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });

  test("responds 404 for a device that isn't running", async () => {
    const res = await fetch(`${baseUrl}/metrics?device=NOT-A-REAL-UDID`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });
});
