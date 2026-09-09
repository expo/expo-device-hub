import { describe, expect, test } from "bun:test";
import { JsonResponseTracker } from "../src/json-response.ts";

describe("JsonResponseTracker", () => {
  test("reports exact UTF-8 response bytes and serialization duration", async () => {
    const measurements = [10, 10.125, 20, 20.75];
    const tracker = new JsonResponseTracker(["page"] as const, {
      measureNow: () => measurements.shift() ?? 0,
      wallNow: () => new Date("2026-07-11T12:00:00.000Z"),
    });

    const firstValue = { text: "hello 😀" };
    const firstBody = JSON.stringify(firstValue);
    const first = tracker.response("page", firstValue, { status: 201 });
    expect(first.status).toBe(201);
    expect(first.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(first.headers.get("content-length")).toBe(
      String(Buffer.byteLength(firstBody, "utf8")),
    );
    expect(await first.text()).toBe(firstBody);

    const secondValue = { values: [1, 2, 3, 4, 5] };
    tracker.response("page", secondValue);
    expect(tracker.snapshot().page).toEqual({
      responses: 2,
      lastBytes: Buffer.byteLength(JSON.stringify(secondValue), "utf8"),
      maxBytes: Math.max(
        Buffer.byteLength(firstBody, "utf8"),
        Buffer.byteLength(JSON.stringify(secondValue), "utf8"),
      ),
      lastSerializationMs: 0.75,
      maxSerializationMs: 0.75,
      lastAt: "2026-07-11T12:00:00.000Z",
    });
  });

  test("snapshots cannot mutate the retained metrics", () => {
    const tracker = new JsonResponseTracker(["health", "export"] as const, {
      measureNow: () => 1,
    });
    tracker.response("health", { ok: true });
    const snapshot = tracker.snapshot();
    snapshot.health.responses = 99;

    expect(tracker.snapshot().health.responses).toBe(1);
    expect(tracker.snapshot().export.responses).toBe(0);
  });
});
