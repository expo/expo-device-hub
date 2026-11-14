import { describe, expect, test } from "bun:test";

import { handleAndroidGpuRequest } from "../android-gpu";

const SOFTWARE = { renderer: "Google SwiftShader", name: "SwiftShader", software: true };
const PHONE = { renderer: "Adreno (TM) 740", name: "Adreno (TM) 740", software: false };
const LISTED = ["emulator-5554", "emulator-5556", "R5CT1234", "192.168.1.20:5555"];
const listSerials = async () => LISTED;
const request = (query: string, method = "GET") =>
  new Request(`http://localhost/api/devices/gpu${query}`, { method });
const mustNotRead = async () => {
  throw new Error("Must not run adb");
};

describe("handleAndroidGpuRequest", () => {
  test("reads the renderer of the requested emulator and reports the host's GPU", async () => {
    const gpuRequest = request("?serial=emulator-5556");
    const response = await handleAndroidGpuRequest(gpuRequest, {
      listSerials,
      detectGpu: async () => true,
      readRenderer: async (serial, options) => {
        expect(serial).toBe("emulator-5556");
        expect(options?.signal).toBe(gpuRequest.signal);
        return { value: SOFTWARE, error: null };
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ gpuAvailable: true, renderer: SOFTWARE });
  });

  test("reads the renderer on a host without a usable GPU too", async () => {
    const response = await handleAndroidGpuRequest(request("?serial=emulator-5554"), {
      listSerials,
      detectGpu: async () => false,
      readRenderer: async () => ({ value: SOFTWARE, error: null }),
    });
    expect(await response.json()).toEqual({ gpuAvailable: false, renderer: SOFTWARE });
  });

  test.each(["R5CT1234", "192.168.1.20:5555"])(
    "reads a physical device the Hub lists: %s",
    async (serial) => {
      const response = await handleAndroidGpuRequest(
        request(`?serial=${encodeURIComponent(serial)}`),
        {
          listSerials,
          detectGpu: async () => true,
          readRenderer: async (read) => {
            expect(read).toBe(serial);
            return { value: PHONE, error: null };
          },
        },
      );
      expect(await response.json()).toEqual({ gpuAvailable: true, renderer: PHONE });
    },
  );

  test("answers an unknown renderer when the read fails or times out", async () => {
    const response = await handleAndroidGpuRequest(request("?serial=emulator-5554"), {
      listSerials,
      detectGpu: async () => true,
      readRenderer: async () => ({ value: null, error: { message: "timeout", error: null } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gpuAvailable: true, renderer: null });
  });

  test.each([
    ["GET", "", 400],
    ["GET", "?serial=", 400],
    ["GET", "?serial=emulator-5560", 404],
    ["GET", "?serial=-s", 404],
    ["GET", "?serial=emulator-5554%20-s", 404],
    ["POST", "?serial=emulator-5554", 405],
  ])("refuses %s %s before it runs adb", async (method, query, status) => {
    const response = await handleAndroidGpuRequest(request(query, method), {
      listSerials,
      detectGpu: async () => true,
      readRenderer: mustNotRead,
    });
    expect(response.status).toBe(status);
  });

  test("reads only the session's device in a single-device session", async () => {
    const singleDevice = { platform: "android" as const, id: "emulator-5554" };
    const other = await handleAndroidGpuRequest(request("?serial=emulator-5556"), {
      listSerials,
      singleDevice,
      detectGpu: async () => true,
      readRenderer: mustNotRead,
    });
    expect(other.status).toBe(403);

    const own = await handleAndroidGpuRequest(request("?serial=emulator-5554"), {
      listSerials,
      singleDevice,
      detectGpu: async () => true,
      readRenderer: async () => ({ value: SOFTWARE, error: null }),
    });
    expect(await own.json()).toEqual({ gpuAvailable: true, renderer: SOFTWARE });
  });
});
