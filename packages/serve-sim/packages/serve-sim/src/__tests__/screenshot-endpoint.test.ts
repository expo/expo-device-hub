import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { describe, expect, spyOn, test } from "bun:test";
import { simMiddleware } from "../middleware";
import { UDID, withShimsAsync } from "./helpers";

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

describe("POST /api/screenshot artifact outcome (stubbed simctl)", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // `xcrun simctl io <udid> screenshot <file>`: the destination is the fifth argument.
  const XCRUN = `#!/bin/sh\nprintf '\\211PNG\\r\\n\\032\\n' > "$5"\n`;

  async function captureWithDirectory(
    prepare: (root: string) => Promise<string>,
    check: (res: Response, directory: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "screenshot-endpoint-"));
    const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
    try {
      const directory = await prepare(root);
      process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = directory;
      await withShimsAsync({ xcrun: XCRUN }, async () => {
        const res = await middleware(
          new Request(`http://localhost:3200/preview/api/screenshot?device=${UDID}`, {
            method: "POST",
            headers: { origin: DASHBOARD },
          }),
        );
        await check(res!, directory);
      });
    } finally {
      if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
      else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previous;
      await rm(root, { recursive: true, force: true });
    }
  }

  test("a saved capture carries only the status header", async () => {
    await captureWithDirectory(
      async (root) => root,
      async (res, directory) => {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(res.headers.get("x-expo-screenshot-artifact")).toBe("saved");
        expect(res.headers.has("x-expo-screenshot-artifact-error")).toBe(false);
        expect(res.headers.get("access-control-expose-headers")).toContain("X-Expo-Screenshot-Artifact");
        expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
        expect(await readdir(directory)).toHaveLength(1);
      },
    );
  });

  test("a failed save still returns the PNG and reports the reason", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await captureWithDirectory(
        async (root) => {
          const occupied = join(root, "occupied");
          await writeFile(occupied, "not a directory");
          return occupied;
        },
        async (res) => {
          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toBe("image/png");
          expect(res.headers.get("x-expo-screenshot-artifact")).toBe("failed");
          expect(res.headers.get("x-expo-screenshot-artifact-error")).toMatch(/EEXIST|ENOTDIR/);
          expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
        },
      );
    } finally {
      consoleError.mockRestore();
    }
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
