import { describe, expect, test } from "bun:test";
import { iosPermissionsBackend, parseIosPermissions } from "../ios-permissions";

const BASE = "http://localhost:3400/vendor/serve-sim/";
const UDID = "0A73225E-069F-4A97-A481-00E701EDC9AA";

function fakeFetch(body: unknown) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { requests, fetchImpl };
}

describe("parseIosPermissions", () => {
  test("keeps the state union and labels the catalogue names", () => {
    expect(
      parseIosPermissions({
        ok: true,
        permissions: [
          { id: "camera", state: "granted" },
          { id: "photos-add", state: "undetermined" },
        ],
      }),
    ).toEqual([
      { id: "camera", label: "Camera", state: "granted" },
      { id: "photos-add", label: "Photos add", state: "undetermined" },
    ]);
    expect(
      parseIosPermissions({ ok: true, permissions: [{ id: "camera", state: "maybe" }] }),
    ).toBeNull();
  });
});

describe("iosPermissionsBackend", () => {
  test("reads and writes through the device-scoped route", async () => {
    const { requests, fetchImpl } = fakeFetch({
      ok: true,
      permissions: [{ id: "camera", state: "denied" }],
    });
    const backend = iosPermissionsBackend(BASE, UDID, fetchImpl);
    await backend.list("dev.expo.Payments");
    const written = await backend.write("dev.expo.Payments", "camera", "revoke");
    await backend.reset("dev.expo.Payments");
    const route = `http://localhost:3400/vendor/serve-sim/permissions?device=${UDID}`;
    expect(requests.map((request) => request.url)).toEqual([
      `${route}&bundleId=dev.expo.Payments`,
      route,
      route,
    ]);
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
      bundleId: "dev.expo.Payments",
      id: "camera",
      action: "revoke",
    });
    expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({
      bundleId: "dev.expo.Payments",
      id: "all",
      action: "reset",
    });
    expect(written).toEqual([{ id: "camera", label: "Camera", state: "denied" }]);
  });
});
