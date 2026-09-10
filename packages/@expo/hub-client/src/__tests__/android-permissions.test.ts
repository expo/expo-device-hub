import { describe, expect, test } from "bun:test";
import { androidPermissionsBackend, parseAndroidPermissions } from "../android-permissions";

const BASE = "http://localhost:3400/vendor/serve-emu";

function fakeFetch(replies: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const reply = replies.shift() ?? { body: { ok: true, permissions: [] } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { requests, fetchImpl };
}

describe("parseAndroidPermissions", () => {
  test("maps dumpsys rows onto labeled granted or denied rows", () => {
    expect(
      parseAndroidPermissions({
        ok: true,
        packageName: "com.android.chrome",
        permissions: [
          { name: "android.permission.CAMERA", granted: false, flags: [] },
          { name: "com.example.CUSTOM_THING", granted: true, flags: ["USER_SET"] },
        ],
      }),
    ).toEqual([
      { id: "android.permission.CAMERA", label: "Camera", state: "denied" },
      { id: "com.example.CUSTOM_THING", label: "Com.example.custom thing", state: "granted" },
    ]);
  });

  test("rejects malformed payloads", () => {
    expect(parseAndroidPermissions({ ok: false })).toBeNull();
    expect(parseAndroidPermissions({ ok: true, permissions: [{ name: 1 }] })).toBeNull();
  });
});

describe("androidPermissionsBackend", () => {
  test("lists through the device-scoped proxy URL", async () => {
    const { requests, fetchImpl } = fakeFetch([
      {
        body: {
          ok: true,
          permissions: [{ name: "android.permission.CAMERA", granted: true, flags: [] }],
        },
      },
    ]);
    const backend = androidPermissionsBackend(BASE, "emulator-5554", fetchImpl);
    const permissions = await backend.list("com.android.chrome");
    expect(requests[0]!.url).toBe(
      `${BASE}/api/apps/permissions?packageName=com.android.chrome&device=emulator-5554`,
    );
    expect(permissions).toEqual([
      { id: "android.permission.CAMERA", label: "Camera", state: "granted" },
    ]);
  });

  test("posts the write, then reads the list back", async () => {
    const { requests, fetchImpl } = fakeFetch([
      { body: { ok: true, output: "" } },
      { body: { ok: true, permissions: [] } },
    ]);
    const backend = androidPermissionsBackend(BASE, null, fetchImpl);
    await backend.write("com.android.chrome", "android.permission.CAMERA", "revoke");
    await backend.reset("com.android.chrome");
    expect(requests.map((request) => request.url)).toEqual([
      `${BASE}/api/apps/revoke`,
      `${BASE}/api/apps/permissions?packageName=com.android.chrome`,
      `${BASE}/api/apps/reset-permissions`,
      `${BASE}/api/apps/permissions?packageName=com.android.chrome`,
    ]);
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      packageName: "com.android.chrome",
      permission: "android.permission.CAMERA",
    });
    expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({
      packageName: "com.android.chrome",
    });
  });

  test("throws the backend error for a failed write without reading back", async () => {
    const { requests, fetchImpl } = fakeFetch([
      { status: 400, body: { ok: false, error: "permission is invalid" } },
    ]);
    const backend = androidPermissionsBackend(BASE, null, fetchImpl);
    await expect(backend.write("com.android.chrome", "nope", "grant")).rejects.toThrow(
      "permission is invalid",
    );
    expect(requests).toHaveLength(1);
  });
});
