import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";

const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await middleware(new Request(`http://127.0.0.1:3200${path}`, init));
  if (!response) throw new Error(`Unhandled request: ${path}`);
  return response;
}

describe("grid catalog and status endpoints", () => {
  test("catalog returns only cacheable static device metadata", async () => {
    const response = await request("/grid/api/catalog?limit=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBeTruthy();

    const body = await response.json() as {
      devices: Array<Record<string, unknown>>;
      total: number;
      offset: number;
      limit: number;
    };
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(2);
    expect(body.devices.length).toBeLessThanOrEqual(2);
    for (const device of body.devices) {
      expect(Object.keys(device).sort()).toEqual([
        "chrome",
        "device",
        "name",
        "placeholderAsset",
        "runtime",
      ]);
    }
  });

  test("catalog supports conditional requests", async () => {
    const first = await request("/grid/api/catalog?limit=2");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.arrayBuffer();

    const second = await request("/grid/api/catalog?limit=2", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  test("status returns only tiny mutable fields", async () => {
    const response = await request("/grid/api/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json() as { statuses: Array<Record<string, unknown>> };
    expect(Array.isArray(body.statuses)).toBe(true);
    for (const status of body.statuses) {
      expect(Object.keys(status).sort()).toEqual(["device", "helper", "state"]);
    }
  });

  test("status event stream sends the same compact initial snapshot", async () => {
    const controller = new AbortController();
    const response = await request("/grid/api/status/events", {
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("\n\n") || !received.includes("data:")) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    const data = received
      .split("\n\n")
      .find((frame) => frame.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    expect(data).toBeTruthy();
    const body = JSON.parse(data!) as { statuses: Array<Record<string, unknown>> };
    for (const status of body.statuses) {
      expect(Object.keys(status).sort()).toEqual(["device", "helper", "state"]);
    }

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
