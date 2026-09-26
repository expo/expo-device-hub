import { describe, expect, test } from "bun:test";

import { applyCaptureEvent, type CapturedRequest } from "../client/hooks/use-capture-stream";
import type { CaptureMeta } from "../capture/store";

const request = (id: string): CapturedRequest => ({
  id, method: "GET", url: `https://a.test/${id}`, status: 200, mimeType: null,
  requestBytes: 0, responseBytes: 0, startedAt: 0, ttfbMs: null, durationMs: null, failure: null,
});
const meta = { attachment: "capturing" } as CaptureMeta;

describe("applyCaptureEvent", () => {
  test("replaces the list on a reconnect instead of merging into it", () => {
    // r1 was cleared on the server while this viewer was disconnected; the replay holds only r2.
    let list = [request("r1"), request("r2")];
    for (const frame of [
      { type: "meta" as const, meta, initial: true as const },
      { type: "finished" as const, request: request("r2") },
    ]) list = applyCaptureEvent(list, frame);
    expect(list.map((r) => r.id)).toEqual(["r2"]);
  });

  test("keeps the list on a live meta update", () => {
    const list = [request("r1")];
    expect(applyCaptureEvent(list, { type: "meta", meta })).toBe(list);
  });

  test("drops a request the server evicted", () => {
    const list = [request("r1"), request("r2")];
    expect(applyCaptureEvent(list, { type: "evicted", id: "r1" }).map((r) => r.id)).toEqual(["r2"]);
  });
});
