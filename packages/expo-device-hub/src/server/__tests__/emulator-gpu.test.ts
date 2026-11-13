import { describe, expect, test } from "bun:test";

import { handleEmulatorGpuRequest } from "../emulator-gpu";

const SOFTWARE = { renderer: "Google SwiftShader", name: "SwiftShader", software: true };
const request = (query: string, method = "GET") =>
  new Request(`http://localhost/api/devices/gpu${query}`, { method });
const mustNotRead = async () => {
  throw new Error("Must not run adb");
};

describe("handleEmulatorGpuRequest", () => {
  test("reads the renderer of the requested emulator when the host has a usable GPU", async () => {
    const gpuRequest = request("?serial=emulator-5556");
    const response = await handleEmulatorGpuRequest(gpuRequest, {
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

  test("does not run adb on a host without a usable GPU", async () => {
    const response = await handleEmulatorGpuRequest(request("?serial=emulator-5554"), {
      detectGpu: async () => false,
      readRenderer: mustNotRead,
    });
    expect(await response.json()).toEqual({ gpuAvailable: false, renderer: null });
  });

  test("answers an unknown renderer when the read fails", async () => {
    const response = await handleEmulatorGpuRequest(request("?serial=emulator-5554"), {
      detectGpu: async () => true,
      readRenderer: async () => ({ value: null, error: { message: "timeout", error: null } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gpuAvailable: true, renderer: null });
  });

  test.each([
    ["GET", "", 400],
    ["GET", "?serial=R5CT1234", 400],
    ["GET", "?serial=emulator-5554%20-s", 400],
    ["POST", "?serial=emulator-5554", 405],
  ])("refuses %s %s before it runs adb", async (method, query, status) => {
    const response = await handleEmulatorGpuRequest(request(query, method), {
      detectGpu: async () => true,
      readRenderer: mustNotRead,
    });
    expect(response.status).toBe(status);
  });

  test("reads only the session's emulator in a single-device session", async () => {
    const singleDevice = { platform: "android" as const, id: "emulator-5554" };
    const other = await handleEmulatorGpuRequest(request("?serial=emulator-5556"), {
      singleDevice,
      detectGpu: async () => true,
      readRenderer: mustNotRead,
    });
    expect(other.status).toBe(403);

    const own = await handleEmulatorGpuRequest(request("?serial=emulator-5554"), {
      singleDevice,
      detectGpu: async () => true,
      readRenderer: async () => ({ value: SOFTWARE, error: null }),
    });
    expect(await own.json()).toEqual({ gpuAvailable: true, renderer: SOFTWARE });
  });
});
