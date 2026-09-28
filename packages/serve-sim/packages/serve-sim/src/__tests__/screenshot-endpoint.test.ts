import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";

// POST {base}/api/screenshot — still-PNG capture via `simctl io <udid> screenshot`.
// Consumed by the Expo Device Hub dashboard's save-screenshot action (the
// serve-sim web UI shells out over exec-ws instead). Restored after the
// fetch-style middleware rewrite (bff5212) dropped the route.

const DASHBOARD = "https://expo.dev";
const SIMULATOR_TEST_TIMEOUT_MS = 45_000;

const middleware = simMiddleware({ basePath: "/preview", corsOrigins: [DASHBOARD] });


describe("POST /api/screenshot", () => {
  test("rejects non-POST methods with CORS headers", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot", {
        headers: { origin: DASHBOARD },
      }),
    );
    expect(res?.status).toBe(405);
    expect(res?.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  test("rejects a malformed device udid with a specific error and CORS headers", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot?device=not-a-udid", {
        method: "POST",
        headers: { origin: DASHBOARD },
      }),
    );
    expect(res?.status).toBe(400);
    expect(res?.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid simulator device ID");
  });

  test("returns CORS headers when screenshot capture fails", async () => {
    const unavailableUdid = "00000000-0000-0000-0000-000000000000";
    const res = await middleware(
      new Request(
        `http://localhost:3200/preview/api/screenshot?device=${unavailableUdid}`,
        { method: "POST", headers: { origin: DASHBOARD } },
      ),
    );
    expect(res?.status).toBe(500);
    expect(res?.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });
});

const bootedUdid = e2eDevice();
const describeWithSim = bootedUdid ? describe : describe.skip;
requireE2E("screenshot-endpoint", Boolean(bootedUdid));

describeWithSim(`POST /api/screenshot (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("persists the exact returned PNG when artifact storage is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-endpoint-"));
    const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
    process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = directory;
    try {
      const res = await middleware(new Request(
        `http://localhost:3200/preview/api/screenshot?device=${bootedUdid}`,
        { method: "POST" },
      ));
      expect(res?.status).toBe(200);
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      const [file] = files;
      if (!file) throw new Error("Missing screenshot artifact");
      expect(await readFile(join(directory, file))).toEqual(Buffer.from(await res!.arrayBuffer()));
    } finally {
      if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
      else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }, SIMULATOR_TEST_TIMEOUT_MS);

  test("returns a PNG for an explicit device", async () => {
    const res = await middleware(
      new Request(
        `http://localhost:3200/preview/api/screenshot?device=${encodeURIComponent(bootedUdid!)}`,
        { method: "POST", headers: { origin: DASHBOARD } },
      ),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_MAGIC);
  }, SIMULATOR_TEST_TIMEOUT_MS);

  test("falls back to a booted simulator when no device is given", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot", { method: "POST" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_MAGIC);
  }, SIMULATOR_TEST_TIMEOUT_MS);
});
