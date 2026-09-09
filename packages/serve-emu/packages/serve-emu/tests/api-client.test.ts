import { describe, expect, test } from "bun:test";
import {
  ApiClientError,
  createApiClient,
  type FetchLike,
} from "../src/ui/lib/api-client.ts";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

describe("API client", () => {
  test("returns legacy success payloads and serializes JSON bodies", async () => {
    let requestInit: RequestInit | undefined;
    const request = createApiClient(async (_input, init) => {
      requestInit = init;
      return jsonResponse({
        ok: true,
        orientation: { mode: "lock", rotation: 0, orientation: "portrait", raw: "lock 0" },
      });
    });

    const result = await request("/api/orientation", {
      method: "POST",
      body: { orientation: "portrait" },
    });

    expect(result.orientation.orientation).toBe("portrait");
    expect(requestInit?.body).toBe(JSON.stringify({ orientation: "portrait" }));
    expect(new Headers(requestInit?.headers).get("Content-Type")).toBe("application/json");
  });

  test("accepts existing success responses that do not carry an ok discriminant", async () => {
    const request = createApiClient(async () =>
      jsonResponse({
        events: [],
        recording: true,
        replaying: false,
        replayStartedAt: null,
        replayCompletedAt: null,
        lastError: null,
      }),
    );

    const session = await request("/api/session", { method: "GET" });

    expect(session.recording).toBe(true);
    expect(session.events).toEqual([]);
  });

  test("passes FormData and AbortSignal through without a multipart content-type override", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      requestInit = init;
      return jsonResponse({ ok: true, output: "installed" });
    };
    const request = createApiClient(fetcher);
    const form = new FormData();
    form.set("apk", new File(["apk"], "demo.apk"));
    const controller = new AbortController();

    await request("/api/apps/install", {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    expect(requestInit?.body).toBe(form);
    expect(requestInit?.signal).toBe(controller.signal);
    expect(new Headers(requestInit?.headers).has("Content-Type")).toBe(false);
  });

  test("preserves abort errors and wraps other transport failures", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortingRequest = createApiClient(async () => {
      throw controller.signal.reason;
    });
    const failingRequest = createApiClient(async () => {
      throw new TypeError("connection refused");
    });

    await expect(
      abortingRequest("/api/device-grid", { method: "GET", signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    await expect(failingRequest("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      message: "Unable to reach the API",
    });
  });

  test("throws typed errors for structured failures even when HTTP status is successful", async () => {
    const request = createApiClient(async () =>
      jsonResponse({
        ok: false,
        error: { code: "invalid_request", message: "orientation is required" },
      }),
    );

    const promise = request("/api/orientation", { method: "GET" });
    await expect(promise).rejects.toBeInstanceOf(ApiClientError);
    await expect(promise).rejects.toMatchObject({
      status: 200,
      code: "invalid_request",
      message: "orientation is required",
    });
  });

  test("preserves status and server error details for non-2xx failures", async () => {
    const request = createApiClient(async () =>
      jsonResponse(
        { ok: false, error: { code: "service_unavailable", message: "device offline" } },
        { status: 503 },
      ),
    );

    await expect(request("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "device offline",
    });
  });

  test("supports original string failures during a rolling upgrade", async () => {
    const request = createApiClient(async () =>
      jsonResponse({ ok: false, error: "old server failure" }, { status: 400 }),
    );

    await expect(request("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 400,
      code: "legacy_error",
      message: "old server failure",
    });
  });

  test("rejects invalid JSON and non-object success payloads", async () => {
    const invalidJson = createApiClient(async () => new Response("not json", { status: 502 }));
    const primitiveJson = createApiClient(async () => jsonResponse("unexpected"));

    await expect(invalidJson("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 502,
      code: "invalid_response",
    });
    await expect(primitiveJson("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("rejects malformed failure discriminants instead of returning them as success", async () => {
    const request = createApiClient(async () =>
      jsonResponse({ ok: false, error: { code: "made_up", message: "bad envelope" } }),
    );

    await expect(request("/api/device-grid", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("rejects malformed failures on success shapes without an ok field", async () => {
    const request = createApiClient(async () =>
      jsonResponse({
        ok: false,
        error: { code: "made_up", message: "bad envelope" },
        events: [],
        recording: true,
        replaying: false,
        replayStartedAt: null,
        replayCompletedAt: null,
        lastError: null,
      }),
    );

    await expect(request("/api/session", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("validates endpoint-specific success payloads before returning them", async () => {
    const request = createApiClient(async () =>
      jsonResponse({ ok: true, orientation: { orientation: "portrait" } }),
    );

    await expect(request("/api/orientation", { method: "GET" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  test("returns binary screenshots without forcing a JSON parse", async () => {
    const request = createApiClient(async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "Content-Type": "image/png" },
      })
    );

    const png = await request("/api/screenshot", { method: "GET" });

    expect(png).toBeInstanceOf(Uint8Array);
    expect(Array.from(png as Uint8Array)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
