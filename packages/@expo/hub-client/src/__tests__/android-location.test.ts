import { describe, expect, test } from "bun:test";

import { parseAndroidFix, readAndroidLocation, writeAndroidLocation } from "../android-location";

const LOCATION_URL = "http://localhost:3401/api/location";
const FIX = { latitude: 37.3349, longitude: -122.009 };
const APPLIED = {
  latitude: 37.3349,
  longitude: -122.009,
  altitude: 12.5,
  satellites: 8,
  velocity: 0,
  appliedAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FakeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function fakeFetch(reply: () => Response | Promise<Response>) {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const impl: FakeFetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return reply();
  };
  return { fetchImpl: impl as typeof fetch, requests };
}

describe("parseAndroidFix", () => {
  test("keeps the coordinate pair and drops the rest of the applied fix", () => {
    expect(parseAndroidFix(APPLIED)).toEqual(FIX);
  });

  test("rejects anything that is not a finite coordinate pair", () => {
    expect(parseAndroidFix(null)).toBeNull();
    expect(parseAndroidFix([37.3349, -122.009])).toBeNull();
    expect(parseAndroidFix({ latitude: 37.3349 })).toBeNull();
    expect(parseAndroidFix({ latitude: "37.3349", longitude: -122.009 })).toBeNull();
    expect(parseAndroidFix({ latitude: Number.NaN, longitude: -122.009 })).toBeNull();
  });
});

describe("readAndroidLocation", () => {
  test("reports a fresh emulator session as supported with no fix", async () => {
    const { fetchImpl, requests } = fakeFetch(() =>
      jsonResponse({ serial: "emulator-5554", emulator: true, location: null }),
    );

    expect(await readAndroidLocation(fetchImpl, LOCATION_URL)).toEqual({
      supported: true,
      location: null,
    });
    expect(requests[0]!.input).toBe(LOCATION_URL);
    expect(requests[0]!.init).toEqual({ cache: "no-store" });
  });

  test("normalizes a remembered fix down to the coordinate pair", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ serial: "emulator-5554", emulator: true, location: APPLIED }),
    );

    expect(await readAndroidLocation(fetchImpl, LOCATION_URL)).toEqual({
      supported: true,
      location: FIX,
    });
  });

  test("reports a physical device as unsupported", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ serial: "R5CT10", emulator: false, location: null }),
    );

    expect(await readAndroidLocation(fetchImpl, LOCATION_URL)).toEqual({
      supported: false,
      location: null,
    });
  });

  test("reports a non-ok response or an unreadable body as unsupported", async () => {
    const notOk = fakeFetch(() => jsonResponse({ emulator: true, location: null }, 500));
    expect(await readAndroidLocation(notOk.fetchImpl, LOCATION_URL)).toEqual({
      supported: false,
      location: null,
    });

    const garbage = fakeFetch(() => new Response("<html>proxy error</html>"));
    expect(await readAndroidLocation(garbage.fetchImpl, LOCATION_URL)).toEqual({
      supported: false,
      location: null,
    });
  });

  test("reports an unreachable backend as unsupported instead of rejecting", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error("connection refused");
    });

    expect(await readAndroidLocation(fetchImpl, LOCATION_URL)).toEqual({
      supported: false,
      location: null,
    });
  });
});

describe("writeAndroidLocation", () => {
  test("posts the coordinate pair as JSON and resolves what serve-emu applied", async () => {
    const { fetchImpl, requests } = fakeFetch(() =>
      jsonResponse({ ok: true, location: { ...APPLIED, latitude: 37.4 } }),
    );

    expect(await writeAndroidLocation(fetchImpl, LOCATION_URL, FIX)).toEqual({
      latitude: 37.4,
      longitude: -122.009,
    });
    expect(requests[0]!.input).toBe(LOCATION_URL);
    expect(requests[0]!.init?.method).toBe("POST");
    expect(requests[0]!.init?.headers).toEqual({ "content-type": "application/json" });
    expect(requests[0]!.init?.body).toBe('{"latitude":37.3349,"longitude":-122.009}');
  });

  test("falls back to the requested fix when the reply carries no readable location", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ ok: true, location: null }));
    expect(await writeAndroidLocation(fetchImpl, LOCATION_URL, FIX)).toEqual(FIX);
  });

  test("rejects with the backend error text", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ ok: false, error: "latitude out of range" }, 400),
    );

    await expect(writeAndroidLocation(fetchImpl, LOCATION_URL, FIX)).rejects.toThrow(
      "latitude out of range",
    );
  });

  test("falls back to the HTTP status when the body carries no error text", async () => {
    const noError = fakeFetch(() => new Response("", { status: 502 }));
    await expect(writeAndroidLocation(noError.fetchImpl, LOCATION_URL, FIX)).rejects.toThrow(
      "Location update failed (502)",
    );

    const notOk = fakeFetch(() => jsonResponse({ location: APPLIED }));
    await expect(writeAndroidLocation(notOk.fetchImpl, LOCATION_URL, FIX)).rejects.toThrow(
      "Location update failed (200)",
    );
  });
});
