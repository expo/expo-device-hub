import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { simMiddleware } from "../middleware";

// POST {base}/api/screenshot — still-PNG capture via `simctl io <udid> screenshot`.
// Consumed by the Expo Device Hub dashboard's save-screenshot action (the
// serve-sim web UI shells out over exec-ws instead). Restored after the
// fetch-style middleware rewrite (bff5212) dropped the route.

const middleware = simMiddleware({ basePath: "/preview" });

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

describe("POST /api/screenshot", () => {
  test("rejects non-POST methods with CORS headers", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot"),
    );
    expect(res?.status).toBe(405);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("rejects a malformed device udid with a specific error and CORS headers", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot?device=not-a-udid", {
        method: "POST",
      }),
    );
    expect(res?.status).toBe(400);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid simulator device ID");
  });

  test("returns CORS headers when screenshot capture fails", async () => {
    const unavailableUdid = "00000000-0000-0000-0000-000000000000";
    const res = await middleware(
      new Request(
        `http://localhost:3200/preview/api/screenshot?device=${unavailableUdid}`,
        { method: "POST" },
      ),
    );
    expect(res?.status).toBe(500);
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
  });
});

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`POST /api/screenshot (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("returns a PNG for an explicit device", async () => {
    const res = await middleware(
      new Request(
        `http://localhost:3200/preview/api/screenshot?device=${encodeURIComponent(bootedUdid!)}`,
        { method: "POST" },
      ),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
  }, 45_000);

  test("falls back to a booted simulator when no device is given", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/screenshot", { method: "POST" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
  }, 45_000);
});
