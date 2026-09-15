import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/api-error.ts";
import type { ApiDependencies } from "../src/api/dependencies.ts";
import {
  createApiRouter,
  type ApiErrorLogContext,
  type ApiLogger,
  type ApiMethod,
} from "../src/api/router.ts";
import { createApiRoutes } from "../src/api/routes/index.ts";
import { placeholderCameraImage } from "../src/camera.ts";
import {
  MAX_APK_MULTIPART_BYTES,
  MAX_MEDIA_MULTIPART_BYTES,
  readMultipartFormData,
} from "../src/api/multipart.ts";
import type {
  ApiErrorCode,
  ApiFailure,
} from "../src/shared/api-contracts.ts";
import { API_SUCCESS_PARSERS } from "../src/shared/api-contracts.ts";

const BASE_URL = "http://127.0.0.1:3011";

const EXPECTED_ROUTES = [
  ["GET", "/api"],
  ["GET", "/api/stream-mode"],
  ["PUT", "/api/stream-mode"],
  ["GET", "/api/stream-settings"],
  ["PATCH", "/api/stream-settings"],
  ["GET", "/api/devices"],
  ["GET", "/api/device-grid"],
  ["POST", "/api/devices/select"],
  ["POST", "/api/avds/start"],
  ["POST", "/api/avds/stop"],
  ["GET", "/api/orientation"],
  ["POST", "/api/orientation"],
  ["GET", "/api/night-mode"],
  ["POST", "/api/night-mode"],
  ["GET", "/api/font-scale"],
  ["POST", "/api/font-scale"],
  ["GET", "/api/network"],
  ["POST", "/api/network"],
  ["GET", "/api/reduce-motion"],
  ["POST", "/api/reduce-motion"],
  ["GET", "/api/high-text-contrast"],
  ["POST", "/api/high-text-contrast"],
  ["GET", "/api/font-weight"],
  ["POST", "/api/font-weight"],
  ["GET", "/api/software-keyboard"],
  ["POST", "/api/software-keyboard"],
  ["GET", "/api/display-density"],
  ["POST", "/api/display-density"],
  ["GET", "/api/logcat"],
  ["GET", "/api/metrics"],
  ["GET", "/api/screenshot"],
  ["POST", "/api/screenshot"],
  ["GET", "/api/foreground"],
  ["GET", "/api/accessibility"],
  ["POST", "/api/accessibility/tap"],
  ["POST", "/api/tap"],
  ["POST", "/api/swipe"],
  ["POST", "/api/text"],
  ["POST", "/api/key"],
  ["POST", "/api/apps/install"],
  ["POST", "/api/files/import"],
  ["POST", "/api/apps/launch"],
  ["POST", "/api/apps/clear"],
  ["POST", "/api/apps/force-stop"],
  ["POST", "/api/apps/grant"],
  ["GET", "/api/apps/permissions"],
  ["POST", "/api/apps/revoke"],
  ["POST", "/api/apps/reset-permissions"],
  ["GET", "/api/apps/icon"],
  ["GET", "/api/location"],
  ["POST", "/api/location"],
  ["GET", "/api/route"],
  ["POST", "/api/route"],
  ["DELETE", "/api/route"],
  ["POST", "/api/route/control"],
  ["GET", "/api/session"],
  ["DELETE", "/api/session"],
  ["POST", "/api/session/replay"],
  ["POST", "/api/session/replay/stop"],
  ["GET", "/api/camera"],
  ["GET", "/api/camera/image"],
  ["POST", "/api/camera/image"],
  ["DELETE", "/api/camera/image"],
] as const satisfies readonly (readonly [ApiMethod, string])[];

const METHOD_ORDER: readonly ApiMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

const VALID_JSON_BODIES: Readonly<Record<string, unknown>> = {
  "PUT /api/stream-mode": {
    mode: "grpc-screenshot",
    grpcImageMode: "mmap",
  },
  "PATCH /api/stream-settings": { maxDimension: 720 },
  "POST /api/devices/select": { serial: "emulator-5554" },
  "POST /api/avds/start": { avd: "Pixel_8_API_35", select: true },
  "POST /api/avds/stop": { serial: "emulator-5554" },
  "POST /api/orientation": { orientation: "portrait" },
  "POST /api/night-mode": { mode: "dark" },
  "POST /api/font-scale": { scale: 1.25 },
  "POST /api/network": { enabled: true },
  "POST /api/reduce-motion": { enabled: true },
  "POST /api/high-text-contrast": { enabled: true },
  "POST /api/font-weight": { enabled: true },
  "POST /api/software-keyboard": { enabled: true },
  "POST /api/display-density": { scale: 1.1 },
  "POST /api/accessibility/tap": { selector: { text: "Continue" } },
  "POST /api/tap": { x: 0.5, y: 0.5 },
  "POST /api/swipe": {
    x1: 0.5,
    y1: 0.8,
    x2: 0.5,
    y2: 0.2,
    durationMs: 250,
  },
  "POST /api/text": { text: "hello" },
  "POST /api/key": { key: "back" },
  "POST /api/apps/launch": {
    packageName: "com.example.app",
    activity: ".MainActivity",
  },
  "POST /api/apps/clear": { packageName: "com.example.app" },
  "POST /api/apps/force-stop": { packageName: "com.example.app" },
  "POST /api/apps/grant": {
    packageName: "com.example.app",
    permission: "android.permission.CAMERA",
  },
  "POST /api/apps/revoke": {
    packageName: "com.example.app",
    permission: "android.permission.CAMERA",
  },
  "POST /api/apps/reset-permissions": { packageName: "com.example.app" },
  "POST /api/location": { latitude: 51.5, longitude: -0.12 },
  "POST /api/route": {
    waypoints: [{ latitude: 51.5, longitude: -0.12 }],
  },
  "POST /api/route/control": { action: "pause" },
  "POST /api/session/replay": { multiplier: 1 },
};

const routeSnapshot = {
  status: "idle",
  waypointCount: 0,
  totalMeters: 0,
  progressMeters: 0,
  speedKph: 30,
  multiplier: 1,
  intervalMs: 1_000,
  loop: false,
  startedAt: null,
  updatedAt: null,
  pausedAt: null,
  completedAt: null,
  lastError: null,
  currentLocation: null,
};

const sessionSnapshot = {
  events: [],
  recording: true,
  replaying: false,
  replayStartedAt: null,
  replayCompletedAt: null,
  lastError: null,
};

const cameraStatus = {
  serial: "emulator-5554",
  supported: true,
  wiredAtLaunch: true,
  launchArgs: ["-camera-back", "imagefile:/tmp/back.png"],
  feeds: [
    {
      facing: "back" as const,
      path: "/tmp/back.png",
      present: true,
      placeholder: false,
      width: 1280,
      height: 960,
      bytes: 1024,
      digest: "a".repeat(64),
      updatedAt: "2026-07-12T10:00:00.000Z",
    },
  ],
};

function fakeDependencies(
  overrides: Partial<ApiDependencies> = {},
): ApiDependencies {
  const dependencies: ApiDependencies = {
    getInfo: () => ({
      generation: 0,
      serial: "emulator-5554",
      device: "Fake device",
      codec: "h264",
      size: { width: 1080, height: 1920 },
      status: "streaming",
      clients: 0,
      stream: { transport: "websocket" },
    }),
    getStreamMode: () => ({
      ok: true,
      serial: "emulator-5554",
      mode: "scrcpy",
      grpcImageMode: "png",
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 0,
    }),
    setStreamMode: async (request) => ({
      ok: true,
      serial: "emulator-5554",
      mode: request.mode,
      grpcImageMode: request.mode === "grpc-screenshot"
        ? request.grpcImageMode ?? "png"
        : "png",
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 1,
    }),
    getStreamEncoderSettings: () => ({
      ok: true,
      maxDimension: 1280,
      h264Bitrate: 8_000_000,
      h264Fps: 60,
    }),
    setStreamEncoderSettings: async (patch) => ({
      ok: true,
      maxDimension: patch.maxDimension ?? 1280,
      h264Bitrate: patch.h264Bitrate ?? 8_000_000,
      h264Fps: patch.h264Fps ?? 60,
    }),
    listDevices: async () => ({
      ok: true,
      currentSerial: "emulator-5554",
      devices: [{ serial: "emulator-5554", state: "device", current: true }],
    }),
    getDeviceGrid: async () => ({
      ok: true,
      currentSerial: "emulator-5554",
      sessionStatus: "streaming",
      devices: [],
    }),
    selectDevice: async (serial) => ({
      ok: true,
      serial,
      device: "Fake device",
    }),
    startAvd: async (avd) => ({
      ok: true,
      serial: "emulator-5556",
      avd,
    }),
    stopAvd: async ({ serial, avd }) => ({
      ok: true,
      serial: serial ?? `running:${avd}`,
    }),

    getOrientation: async () => ({
      mode: "free",
      rotation: 0,
      orientation: "portrait",
      raw: "0 0",
    }),
    setOrientation: async (orientation) => ({ orientation }),
    getNightMode: async () => ({ mode: "light", raw: "no" }),
    setNightMode: async (mode) => ({ mode, raw: mode }),
    getFontScale: async () => ({ scale: 1, raw: "1.0" }),
    setFontScale: async (scale) => ({ scale, raw: String(scale) }),
    getNetwork: async () => ({
      enabled: true,
      wifi: "enabled",
      mobileData: "enabled",
      raw: { wifi: "enabled", mobileData: "enabled" },
    }),
    setNetwork: async (enabled) => ({
      enabled,
      wifi: enabled ? "enabled" : "disabled",
      mobileData: enabled ? "enabled" : "disabled",
      raw: { wifi: String(enabled), mobileData: String(enabled) },
    }),
    getReduceMotion: async () => ({
      enabled: false,
      raw: { transition: "1", window: "1", animator: "1" },
    }),
    setReduceMotion: async (enabled) => ({
      enabled,
      raw: enabled
        ? { transition: "0", window: "0", animator: "0" }
        : { transition: "1", window: "1", animator: "1" },
    }),
    getHighTextContrast: async () => ({ enabled: false, raw: "0" }),
    setHighTextContrast: async (enabled) => ({
      enabled,
      raw: enabled ? "1" : "0",
    }),
    getFontWeight: async () => ({ enabled: false, raw: "0" }),
    setFontWeight: async (enabled) => ({ enabled, raw: enabled ? "300" : "0" }),
    getSoftwareKeyboard: async () => ({ enabled: false, raw: "0" }),
    setSoftwareKeyboard: async (enabled) => ({ enabled, raw: enabled ? "1" : "0" }),
    getDisplayDensity: async () => ({ scale: 1, widthDp: 411, raw: "Physical density: 420" }),
    setDisplayDensity: async (scale) => ({
      scale,
      widthDp: Math.round(411 / scale),
      raw: "Physical density: 420",
    }),

    openLogcat: () =>
      new Response("event: ready\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    openMetrics: () =>
      new Response(":\n\n", { headers: { "Content-Type": "text/event-stream" } }),
    takeScreenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    getForegroundApp: async () => ({
      packageName: "com.example.app",
      activity: ".MainActivity",
      pid: 42,
      label: "Example",
      versionName: "1.0",
      versionCode: "1",
      debuggable: true,
    }),
    getAccessibility: async () => ({
      ok: true,
      capturedAt: "2026-01-01T00:00:00.000Z",
      screen: { width: 1080, height: 2400 },
      nodes: [],
    }),
    tapAccessibility: async () => ({
      ok: true,
      capturedAt: "2026-01-01T00:00:00.000Z",
      node: {
        id: "0",
        text: "Continue",
        contentDescription: "",
        resourceId: "com.example:id/continue",
        className: "android.widget.Button",
        packageName: "com.example.app",
        clickable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      },
    }),

    dispatchGesture: async () => {},

    getSession: () => sessionSnapshot,
    clearSession: () => sessionSnapshot,
    replaySession: () => sessionSnapshot,
    stopSessionReplay: () => sessionSnapshot,

    installApk: async (file) => ({
      ok: true,
      output: `installed ${file.name}`,
    }),
    importFile: async (file) => ({
      ok: true,
      output: `imported ${file.name}`,
      path: `/sdcard/Download/${file.name}`,
      kind: "file",
    }),
    launchApp: async (packageName, activity) => ({
      ok: true,
      output: `launched ${packageName}/${activity ?? "default"}`,
    }),
    clearApp: async (packageName) => ({
      ok: true,
      output: `cleared ${packageName}`,
    }),
    forceStopApp: async (packageName) => ({
      ok: true,
      output: `stopped ${packageName}`,
    }),
    grantPermission: async (packageName, permission) => ({
      ok: true,
      output: `granted ${permission} to ${packageName}`,
    }),
    listPermissions: async (packageName) => ({
      ok: true,
      packageName,
      permissions: [
        { name: "android.permission.CAMERA", granted: false, flags: ["USER_SET"] },
      ],
    }),
    revokePermission: async (packageName, permission) => ({
      ok: true,
      output: `revoked ${permission} from ${packageName}`,
    }),
    resetPermissions: async (packageName) => ({
      ok: true,
      output: `reset ${packageName}`,
    }),
    readAppIcon: async () => ({ mimeType: "image/png", data: "aWNvbg==" }),

    getLocation: () => ({
      serial: "emulator-5554",
      emulator: true,
      location: null,
    }),
    setLocation: async (fix) => ({
      ...fix,
      appliedAt: "2026-01-01T00:00:00.000Z",
    }),
    getRoute: () => routeSnapshot,
    startRoute: async () => routeSnapshot,
    stopRoute: () => routeSnapshot,
    controlRoute: () => routeSnapshot,
    getCamera: async () => cameraStatus,
    setCameraImage: async () => {},
    clearCameraImage: async () => {},
    readCameraImage: async () => placeholderCameraImage().png,
  };

  return { ...dependencies, ...overrides };
}

function multipartRequest(method: ApiMethod, path: string, field: string) {
  const form = new FormData();
  form.set(
    field,
    new File([field === "apk" ? "fake apk" : "fake file"],
      field === "apk" ? "example.apk" : "example.txt"),
  );
  return new Request(`${BASE_URL}${path}`, { method, body: form });
}

function validRequest(method: ApiMethod, path: string): Request {
  const key = `${method} ${path}`;
  if (key === "POST /api/apps/install") {
    return multipartRequest(method, path, "apk");
  }
  if (key === "POST /api/files/import") {
    return multipartRequest(method, path, "file");
  }

  if (key === "POST /api/camera/image") {
    return new Request(`${BASE_URL}${path}?facing=back`, {
      method,
      body: placeholderCameraImage().png,
      headers: { "Content-Type": "image/png" },
    });
  }

  const body = VALID_JSON_BODIES[key];
  const requestPath = key === "GET /api/screenshot"
    ? `${path}?format=base64`
    : key === "GET /api/apps/permissions" || key === "GET /api/apps/icon"
      ? `${path}?packageName=com.example.app`
      : path;
  return new Request(`${BASE_URL}${requestPath}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });
}

function expectedAllow(path: string): string {
  const methods = new Set<ApiMethod>(
    EXPECTED_ROUTES
      .filter((route) => route[1] === path)
      .map((route) => route[0]),
  );
  return METHOD_ORDER.filter((method) => methods.has(method)).join(", ");
}

async function expectFailure(
  response: Response | null,
  status: number,
  code: ApiErrorCode,
  message?: string,
): Promise<ApiFailure> {
  expect(response).toBeInstanceOf(Response);
  expect(response!.status).toBe(status);
  expect(response!.headers.get("content-type")).toBe(
    "application/json; charset=utf-8",
  );
  const body = (await response!.json()) as ApiFailure;
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
  return body;
}

const silentLogger: ApiLogger = {
  error() {},
};

describe("domain API route table", () => {
  test("registers the exact 63 method/path pairs across 45 paths", () => {
    const routes = createApiRoutes();

    expect(routes.map(({ method, path }) => [method, path])).toEqual(
      EXPECTED_ROUTES.map(([method, path]) => [method, path]),
    );
    expect(routes).toHaveLength(63);
    expect(new Set(routes.map((route) => route.path)).size).toBe(45);
    const contractPairs = Object.entries(API_SUCCESS_PARSERS).flatMap(
      ([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`),
    );
    expect(contractPairs.sort()).toEqual(
      EXPECTED_ROUTES.map(([method, path]) => `${method} ${path}`).sort(),
    );
  });

  test("runs every allowed route against complete fake dependencies", async () => {
    const router = createApiRouter(createApiRoutes());
    const deps = fakeDependencies();
    const invoked: string[] = [];

    for (const [method, path] of EXPECTED_ROUTES) {
      const key = `${method} ${path}`;
      const response = await router.handle(validRequest(method, path), deps);
      if (!response || !response.ok) {
        const detail = response ? await response.text() : "router declined";
        throw new Error(`${key} failed: ${detail}`);
      }
      await response.arrayBuffer();
      invoked.push(key);
    }

    expect(invoked).toEqual(
      EXPECTED_ROUTES.map(([method, path]) => `${method} ${path}`),
    );
  });

  test("returns structured OPTIONS 405 with exact Allow for all 45 paths", async () => {
    const router = createApiRouter(createApiRoutes());
    const deps = fakeDependencies();
    const paths = [...new Set(EXPECTED_ROUTES.map((route) => route[1]))];

    expect(paths).toHaveLength(45);
    for (const path of paths) {
      const response = await router.handle(
        new Request(`${BASE_URL}${path}`, { method: "OPTIONS" }),
        deps,
      );
      await expectFailure(
        response,
        405,
        "method_not_allowed",
        "Method not allowed for this API route",
      );
      expect(response!.headers.get("allow")).toBe(expectedAllow(path));
    }
  });
});

describe("domain API failures", () => {
  test("rejects an unsupported stream mode before dependency work", async () => {
    let invoked = false;
    const router = createApiRouter(createApiRoutes());
    const response = await router.handle(
      new Request(`${BASE_URL}/api/stream-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "screen-copy" }),
      }),
      fakeDependencies({
        setStreamMode: async () => {
          invoked = true;
          throw new Error("must not run");
        },
      }),
    );

    await expectFailure(
      response,
      400,
      "invalid_request",
      "stream mode request.mode is invalid",
    );
    expect(invoked).toBe(false);
  });

  test("maps invalid route input to 400", async () => {
    const router = createApiRouter(createApiRoutes());
    const response = await router.handle(
      new Request(`${BASE_URL}/api/orientation`, {
        method: "POST",
        body: JSON.stringify({ orientation: "upside-down" }),
      }),
      fakeDependencies(),
    );

    await expectFailure(
      response,
      400,
      "invalid_request",
      "orientation must be auto, portrait, or landscape",
    );

    const streamSettings = await router.handle(
      new Request(`${BASE_URL}/api/stream-settings`, {
        method: "PATCH",
        body: JSON.stringify({ h264Fps: 0 }),
      }),
      fakeDependencies(),
    );
    await expectFailure(
      streamSettings,
      400,
      "invalid_request",
      "h264Fps must be an integer between 1 and 120",
    );
  });

  test("rejects non-numeric font scales before dependency work", async () => {
    const router = createApiRouter(createApiRoutes());
    for (const scale of [true, "1.5", [1.2]]) {
      let invoked = false;
      const response = await router.handle(
        new Request(`${BASE_URL}/api/font-scale`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scale }),
        }),
        fakeDependencies({
          setFontScale: async () => {
            invoked = true;
            throw new Error("must not run");
          },
        }),
      );

      await expectFailure(
        response,
        400,
        "invalid_request",
        "scale must be a number between 0.7 and 2.0",
      );
      expect(invoked).toBe(false);
    }
  });

  test("preserves domain conflicts as 409", async () => {
    const router = createApiRouter(createApiRoutes());
    const response = await router.handle(
      validRequest("POST", "/api/devices/select"),
      fakeDependencies({
        selectDevice: async () => {
          throw new ApiError(409, "conflict", "Device switch in progress");
        },
      }),
    );

    await expectFailure(
      response,
      409,
      "conflict",
      "Device switch in progress",
    );
  });

  test("rejects oversized JSON as 413 before invoking the dependency", async () => {
    let invoked = false;
    const router = createApiRouter(createApiRoutes());
    const response = await router.handle(
      new Request(`${BASE_URL}/api/text`, {
        method: "POST",
        body: JSON.stringify({ text: "x".repeat(8_192) }),
      }),
      fakeDependencies({
        dispatchGesture: async () => {
          invoked = true;
        },
      }),
    );

    await expectFailure(
      response,
      413,
      "payload_too_large",
      "Request body is too large",
    );
    expect(invoked).toBe(false);
  });

  test("bounds declared and actually received multipart bytes", async () => {
    const router = createApiRouter(createApiRoutes());
    const cases = [
      ["/api/apps/install", MAX_APK_MULTIPART_BYTES],
      ["/api/files/import", MAX_MEDIA_MULTIPART_BYTES],
    ] as const;

    for (const [path, maxBytes] of cases) {
      const valid = multipartRequest(
        "POST",
        path,
        path.endsWith("install") ? "apk" : "file",
      );
      const headers = new Headers(valid.headers);
      headers.set("Content-Length", String(maxBytes + 1));
      const response = await router.handle(
        new Request(`${BASE_URL}${path}`, {
          method: "POST",
          headers,
          body: "small body rejected from its declared size",
        }),
        fakeDependencies(),
      );
      await expectFailure(
        response,
        413,
        "payload_too_large",
        "Request body is too large",
      );
    }

    const actual = multipartRequest("POST", "/api/files/import", "file");
    await expect(readMultipartFormData(actual, 8)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  test("rejects a non-APK upload as invalid input before dependency work", async () => {
    let invoked = false;
    const form = new FormData();
    form.set("apk", new File(["not an apk"], "notes.txt"));
    const router = createApiRouter(createApiRoutes());
    const response = await router.handle(
      new Request(`${BASE_URL}/api/apps/install`, {
        method: "POST",
        body: form,
      }),
      fakeDependencies({
        installApk: async () => {
          invoked = true;
          return { ok: true, output: "should not run" };
        },
      }),
    );

    await expectFailure(
      response,
      400,
      "invalid_request",
      "APK file must end with .apk",
    );
    expect(invoked).toBe(false);
  });

  test("preserves missing-resource and capability conflicts", async () => {
    const router = createApiRouter(createApiRoutes());
    const missingAvd = await router.handle(
      validRequest("POST", "/api/avds/start"),
      fakeDependencies({
        startAvd: async () => {
          throw new ApiError(404, "not_found", "Unknown AVD");
        },
      }),
    );
    await expectFailure(missingAvd, 404, "not_found", "Unknown AVD");

    const missingSerial = await router.handle(
      new Request(`${BASE_URL}/api/avds/stop`, {
        method: "POST",
        body: JSON.stringify({ serial: "emulator-9998" }),
      }),
      fakeDependencies({
        stopAvd: async ({ serial }) => {
          expect(serial).toBe("emulator-9998");
          throw new ApiError(
            404,
            "not_found",
            'Unknown emulator "emulator-9998".',
          );
        },
      }),
    );
    await expectFailure(
      missingSerial,
      404,
      "not_found",
      'Unknown emulator "emulator-9998".',
    );

    const physicalLocation = await router.handle(
      validRequest("POST", "/api/location"),
      fakeDependencies({
        setLocation: async () => {
          throw new ApiError(
            409,
            "conflict",
            "location control requires an Android Emulator",
          );
        },
      }),
    );
    await expectFailure(
      physicalLocation,
      409,
      "conflict",
      "location control requires an Android Emulator",
    );
  });

  test("maps downstream errors to a safe 502 response", async () => {
    const secret = "adb output containing device-secret-123";
    const router = createApiRouter(createApiRoutes(), {
      logger: silentLogger,
    });
    const response = await router.handle(
      new Request(`${BASE_URL}/api/devices`),
      fakeDependencies({
        listDevices: async () => {
          throw new Error(secret);
        },
      }),
    );
    const body = await expectFailure(
      response,
      502,
      "downstream_failure",
      "list devices failed",
    );

    expect(JSON.stringify(body)).not.toContain(secret);
  });

  test("sanitizes unexpected 500 responses and request logging context", async () => {
    const logs: ApiErrorLogContext[] = [];
    const logger: ApiLogger = {
      error(_message, context) {
        logs.push(context);
      },
    };
    const internalDetail = "database password is hunter2";
    const router = createApiRouter(createApiRoutes(), { logger });
    const response = await router.handle(
      new Request(`${BASE_URL}/api?token=query-secret`),
      fakeDependencies({
        getInfo: () => {
          throw new Error(internalDetail);
        },
      }),
    );
    const body = await expectFailure(
      response,
      500,
      "internal_error",
      "Internal server error",
    );

    expect(JSON.stringify(body)).not.toContain(internalDetail);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.path).toBe("/api");
    expect(JSON.stringify(logs[0])).not.toContain("query-secret");
  });

  test("returns a structured 404 for an unknown API path", async () => {
    const router = createApiRouter(createApiRoutes());
    const response = await router.handle(
      new Request(`${BASE_URL}/api/not-registered`),
      fakeDependencies(),
    );

    await expectFailure(response, 404, "not_found", "API route not found");
  });
});
