import { describe, expect, test } from "bun:test";
import { DeviceFeatureUnavailableError, runHostActionAsync } from "../host-actions";
import { previewConfigForState, simMiddleware } from "../middleware";
import { clearDeviceEnd, recordDeviceEnd } from "../device-end";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearServeSimState, inProcessServeSimState, stateDir, stateFileForDevice } from "../state";

const PHONE = "00008101-0016603236F0801E";
const SIMULATOR = "C485D903-49A6-4A6D-A199-7893ACF635AE";
const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await middleware(new Request(`http://127.0.0.1:3200${path}`, init));
  if (!response) throw new Error(`Unhandled request: ${path}`);
  return response;
}

describe("routes a physical device does not have", () => {
  test.each([
    ["/logs", "Device logs and crash reports are not available on a physical device."],
    ["/crashes", "Device logs and crash reports are not available on a physical device."],
    ["/appstate", "The foreground app is not available on a physical device."],
    ["/ax", "The accessibility tree is not available on a physical device."],
    ["/metrics", "Activity metrics are not available on a physical device."],
    ["/api/pasteboard", "Clipboard is not available on a physical device."],
    [
      "/api/apps/icon",
      "App install, launch, files and icons are not available on a physical device.",
    ],
    ["/devtools", "Web Inspector is not available on a physical device."],
  ])("%s refuses with the reason", async (path, reason) => {
    const response = await request(`${path}?device=${PHONE}`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: reason });
  });

  test.each([
    ["ax", "The accessibility tree is not available on a physical device."],
    ["foreground", "The foreground app is not available on a physical device."],
    [
      "camera/status",
      "Camera injection and network capture are not available on a physical device.",
    ],
    ["panel/1/stream.mjpeg", "Hinge controls are not available on a physical device."],
  ])("helper route %s refuses with the reason", async (path, reason) => {
    const response = await request(`/helper/${PHONE}/${path}`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: reason });
  });

  test("grid shutdown refuses a phone", async () => {
    const response = await request("/grid/api/shutdown", {
      method: "POST",
      body: JSON.stringify({ udid: PHONE }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Booting and shutting down are not available on a physical device.",
    });
  });

  test("a simulator's route is not refused by the gate", async () => {
    const response = await request(`/ax?device=${SIMULATOR}`);

    expect(response.status).not.toBe(409);
    await response.arrayBuffer();
  });
});

describe("host actions a physical device does not have", () => {
  test.each([
    ["location.set", { udid: PHONE, lat: 1, lng: 2 }, "Location is not available"],
    ["appearance.set", { udid: PHONE, value: "dark" }, "Simulator settings are not available"],
    ["app.launch", { udid: PHONE, bundleId: "com.example.app" }, "App install, launch"],
    ["permissions.list", { udid: PHONE }, "App permissions are not available"],
    ["hinge.get", { udid: PHONE }, "Hinge controls are not available"],
    ["rotate", { udid: PHONE, value: "landscape" }, "Rotate is not available"],
    ["clipboard.read", { udid: PHONE }, "Clipboard is not available"],
    [
      "button",
      { udid: PHONE, value: "lock" },
      "Hardware buttons other than Home are not available",
    ],
  ])("%s refuses before running anything", async (action, params, reason) => {
    const run = runHostActionAsync({ action, params }, "/nonexistent/serve-sim");

    await expect(run).rejects.toBeInstanceOf(DeviceFeatureUnavailableError);
    await expect(run).rejects.toThrow(reason);
  });
});

test("a physical device's Home button goes past the gate", async () => {
  const run = runHostActionAsync(
    { action: "button", params: { udid: PHONE, value: "home" } },
    "/nonexistent/serve-sim",
  );

  await expect(run).resolves.toHaveProperty("exitCode");
});

describe("preview config", () => {
  test("a physical device reports each unavailable feature and offers no clipboard", () => {
    const config = previewConfigForState(inProcessServeSimState(PHONE, 3200), "", "token");

    expect(config.deviceKind).toBe("physical");
    expect(config.unavailableFeatures.location).toBe(
      "Location is not available on a physical device.",
    );
    expect(Object.keys(config.unavailableFeatures)).toHaveLength(15);
    expect(config.inputPaste).toBeUndefined();
    expect(config.inputCopy).toBeUndefined();
  });

  test("a simulator reports every feature", () => {
    const config = previewConfigForState(inProcessServeSimState(SIMULATOR, 3200), "", "token");

    expect(config.deviceKind).toBe("simulator");
    expect(config.unavailableFeatures).toEqual({});
    expect(config.inputPaste).toBe(true);
  });
});

describe("a phone's lifecycle", () => {
  test("a screenshot of a phone whose session ended answers with the reason", async () => {
    recordDeviceEnd(PHONE, "iPhone disconnected");

    const response = await request(`/api/screenshot?device=${PHONE}`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "iPhone disconnected" });
  });

  test("discovery reports why the phone's session ended until the phone is started again", async () => {
    recordDeviceEnd(PHONE, "iPhone disconnected");

    const ended = await request(`/api?device=${PHONE}`);
    expect(await ended.json()).toEqual({ device: PHONE, ended: { reason: "iPhone disconnected" } });

    const started = await request("/grid/api/start", {
      method: "POST",
      body: JSON.stringify({ udid: PHONE }),
    });
    expect(await started.json()).toEqual({ ok: true });

    const config = (await (await request(`/api?device=${PHONE}`)).json()) as Record<
      string,
      unknown
    >;
    expect(config.ended).toBeUndefined();
    expect(config.device).toBe(PHONE);
    expect(config.deviceKind).toBe("physical");
    clearServeSimState(PHONE, process.pid);
  });

  test("discovery reports this server's end while another server publishes the phone", async () => {
    const otherServer = process.ppid;
    writeFileSync(
      stateFileForDevice(PHONE),
      JSON.stringify({ ...inProcessServeSimState(PHONE, 57665), pid: otherServer }),
    );
    recordDeviceEnd(PHONE, "iPhone disconnected");

    const ended = await request(`/api?device=${PHONE}`);

    expect(await ended.json()).toEqual({ device: PHONE, ended: { reason: "iPhone disconnected" } });
    clearServeSimState(PHONE, otherServer);
  });

  test("the discovery feed reports the end while another server publishes the phone", async () => {
    const otherServer = process.ppid;
    writeFileSync(
      stateFileForDevice(PHONE),
      JSON.stringify({ ...inProcessServeSimState(PHONE, 57665), pid: otherServer }),
    );
    clearDeviceEnd(PHONE);
    const controller = new AbortController();
    const response = await request(`/api/events?device=${PHONE}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const nextPayload = async () => {
      for (;;) {
        const match = /data: (.*)\n\n/.exec(text);
        if (match) {
          text = text.slice(match.index + match[0].length);
          return JSON.parse(match[1]!) as {
            device?: string;
            url?: string;
            ended?: { reason: string };
          };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("The feed closed");
        text += decoder.decode(value, { stream: true });
      }
    };
    try {
      expect((await nextPayload()).url).toBeDefined();
      await Bun.sleep(600);

      recordDeviceEnd(PHONE, "iPhone disconnected");

      const ended = await Promise.race([nextPayload(), Bun.sleep(2_000).then(() => null)]);
      expect(ended).toEqual({ device: PHONE, ended: { reason: "iPhone disconnected" } });
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
      clearServeSimState(PHONE, otherServer);
    }
  });

  test("starting a phone that another server streams answers 409 with the reason", async () => {
    const lock = join(stateDir(), `physical-stream-${PHONE}.lock`);
    writeFileSync(lock, String(process.ppid));
    try {
      const started = await request("/grid/api/start", {
        method: "POST",
        body: JSON.stringify({ udid: PHONE }),
      });

      expect(started.status).toBe(409);
      expect(await started.json()).toEqual({
        ok: false,
        error: `iPhone is streaming in another serve-sim (pid ${process.ppid})`,
      });
    } finally {
      rmSync(lock, { force: true });
    }
  });

  test("discovery offers no proxied config for a phone that another server streams", async () => {
    const lock = join(stateDir(), `physical-stream-${PHONE}.lock`);
    const otherServer = process.ppid;
    writeFileSync(
      stateFileForDevice(PHONE),
      JSON.stringify({ ...inProcessServeSimState(PHONE, 3398), pid: otherServer }),
    );
    writeFileSync(lock, String(otherServer));
    clearDeviceEnd(PHONE);
    try {
      const response = await request(`/api?device=${PHONE}`);

      expect(await response.json()).toBeNull();
    } finally {
      rmSync(lock, { force: true });
      clearServeSimState(PHONE, otherServer);
    }
  });
});
