import { describe, expect, test } from "bun:test";
import {
  carryForwardAppDetails,
  fetchAndroidAppDetails,
  parseAppIconResponse,
  parseAppLabel,
} from "../android-app-icon";

const BASE = "http://localhost:3400/vendor/serve-emu";

function jsonFetch(body: unknown, status = 200) {
  const requests: string[] = [];
  const fetchImpl = async (input: string) => {
    requests.push(input);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { requests, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("Android app details", () => {
  test("asks serve-emu for the selected device and package", async () => {
    const { requests, fetchImpl } = jsonFetch({
      ok: true,
      packageName: "com.android.settings",
      icon: { mimeType: "image/png", data: "aWNvbg==" },
      label: "Settings",
    });

    const details = await fetchAndroidAppDetails(
      BASE,
      "emulator-5554",
      "com.android.settings",
      fetchImpl,
    );

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!);
    expect(url.pathname).toBe("/vendor/serve-emu/api/apps/icon");
    expect(url.searchParams.get("device")).toBe("emulator-5554");
    expect(url.searchParams.get("packageName")).toBe("com.android.settings");
    expect(details).toEqual({ iconDataUrl: "data:image/png;base64,aWNvbg==", label: "Settings" });
  });

  test("carries the backend MIME type instead of assuming PNG", async () => {
    const { fetchImpl } = jsonFetch({
      ok: true,
      packageName: "com.android.chrome",
      icon: { mimeType: "image/webp", data: "d2VicA==" },
    });

    expect(
      (await fetchAndroidAppDetails(BASE, null, "com.android.chrome", fetchImpl)).iconDataUrl,
    ).toBe("data:image/webp;base64,d2VicA==");
  });

  test("keeps the label when the package exposes no bitmap", async () => {
    const { fetchImpl } = jsonFetch({
      ok: true,
      packageName: "com.example.app",
      icon: null,
      label: "Example",
    });

    expect(await fetchAndroidAppDetails(BASE, null, "com.example.app", fetchImpl)).toEqual({
      iconDataUrl: null,
      label: "Example",
    });
  });

  test("reads an older serve-emu without a label as an unknown label", async () => {
    const { fetchImpl } = jsonFetch({ ok: true, packageName: "com.example.app", icon: null });

    expect(await fetchAndroidAppDetails(BASE, null, "com.example.app", fetchImpl)).toEqual({
      iconDataUrl: null,
      label: null,
    });
  });

  test("throws on a failure response so the cache does not keep the miss", async () => {
    const { fetchImpl } = jsonFetch({ ok: false, error: "packageName is invalid" }, 400);

    await expect(fetchAndroidAppDetails(BASE, null, "com.example.app", fetchImpl)).rejects.toThrow(
      "400",
    );
  });
});

describe("parseAppIconResponse", () => {
  test("accepts every MIME type the backend can return", () => {
    for (const mimeType of ["image/png", "image/webp", "image/jpeg", "image/gif"]) {
      expect(parseAppIconResponse({ ok: true, icon: { mimeType, data: "aWNvbg==" } })).toBe(
        `data:${mimeType};base64,aWNvbg==`,
      );
    }
  });

  test("rejects a MIME type outside that set instead of building its data URL", () => {
    expect(() =>
      parseAppIconResponse({ ok: true, icon: { mimeType: "image/svg+xml", data: "PHN2Zz4=" } }),
    ).toThrow("mimeType is invalid");
    expect(() =>
      parseAppIconResponse({ ok: true, icon: { mimeType: "text/html;base64,x", data: "eA==" } }),
    ).toThrow("mimeType is invalid");
  });

  test("rejects a payload that is not a success envelope", () => {
    expect(() => parseAppIconResponse(null)).toThrow("response is invalid");
    expect(() => parseAppIconResponse([{ ok: true, icon: null }])).toThrow("response is invalid");
    expect(() => parseAppIconResponse({ ok: false, error: "nope" })).toThrow("response is invalid");
  });

  test("rejects a missing or malformed icon member", () => {
    expect(() => parseAppIconResponse({ ok: true })).toThrow("must be an object");
    expect(() =>
      parseAppIconResponse({ ok: true, icon: "data:image/png;base64,aWNvbg==" }),
    ).toThrow("must be an object");
    expect(() => parseAppIconResponse({ ok: true, icon: { mimeType: "image/png" } })).toThrow(
      "data is invalid",
    );
    expect(() =>
      parseAppIconResponse({ ok: true, icon: { mimeType: "image/png", data: "" } }),
    ).toThrow("data is invalid");
  });
});

describe("parseAppLabel", () => {
  test("reads a non-empty label and treats anything else as unknown", () => {
    expect(parseAppLabel({ ok: true, label: "Settings" })).toBe("Settings");
    expect(parseAppLabel({ ok: true, label: "" })).toBeNull();
    expect(parseAppLabel({ ok: true, label: null })).toBeNull();
    expect(parseAppLabel({ ok: true, label: 7 })).toBeNull();
    expect(parseAppLabel({ ok: true })).toBeNull();
    expect(parseAppLabel(null)).toBeNull();
  });
});

describe("carryForwardAppDetails", () => {
  const settings = {
    id: "com.android.settings",
    iconDataUrl: "data:image/png;base64,aWNvbg==",
    label: "Settings",
  };

  test("keeps the resolved icon and label when another field of the same app changes", () => {
    const next = { id: "com.android.settings", pid: 4242 };

    expect(carryForwardAppDetails(settings, next)).toEqual({
      ...next,
      iconDataUrl: settings.iconDataUrl,
      label: settings.label,
    });
  });

  test("returns the same object when there is nothing to carry", () => {
    const next = { id: "com.android.settings", pid: 4242 };

    expect(carryForwardAppDetails({ id: "com.android.settings" }, next)).toBe(next);
  });

  test("keeps both across a reinstall until the new build's details arrive", () => {
    const resolved = { ...settings, version: "16", build: "907" };
    const next = { id: "com.android.settings", version: "16", build: "908" };

    expect(carryForwardAppDetails(resolved, next)).toEqual({
      ...next,
      iconDataUrl: settings.iconDataUrl,
      label: settings.label,
    });
  });

  test("drops both when the foreground app changes", () => {
    const next = { id: "com.android.chrome" };

    expect(carryForwardAppDetails(settings, next)).toEqual(next);
  });

  test("never overwrites a value the update already carries", () => {
    const next = {
      id: "com.android.settings",
      iconDataUrl: "data:image/webp;base64,d2VicA==",
      label: "Settings (new)",
    };

    expect(carryForwardAppDetails(settings, next)).toEqual(next);
  });

  test("passes the first sighting through", () => {
    const next = { id: "com.android.settings" };

    expect(carryForwardAppDetails(null, next)).toEqual(next);
  });
});
