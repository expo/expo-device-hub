import { afterAll, afterEach, expect, mock, test } from "bun:test";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UDID, installShims, useTempStateDir } from "../helpers";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import type { StreamEncoderSettings } from "../../stream-settings";

let active: number | Error = 1;
let sequence: Array<number | Error> = [];
let stops = 0;
let startupError: Error | undefined;
let screenshotGate: Promise<void> | undefined;
const conversions: number[][] = [];
const nativeWidths: number[] = [];
let rejectJpeg = false;
const captures: Array<{ udid: string; settings: StreamEncoderSettings }> = [];
class Capture {
  async screenshot(display: number, maxWidth = 0) {
    nativeWidths.push(maxWidth);
    await screenshotGate;
    appendFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, `native --display=${display}\n`);
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from(`native --display=${display}`),
    ]);
  }
  constructor(udid: string, settings: StreamEncoderSettings) {
    captures.push({ udid, settings });
  }
  async start() {
    if (startupError) throw startupError;
  }
  async stop() {
    stops++;
  }
  async subscribeScreenChanges() {
    return async () => {};
  }
  async subscribeDeviceState() {
    return async () => {};
  }
  async screenSize() {
    return { width: 2007, height: 2853, screenId: 3, orientation: "portrait" };
  }
  async activeScreenId() {
    const value = sequence.shift() ?? active;
    if (value instanceof Error) throw value;
    return value;
  }
}
mock.module("../../native", () => ({
  ...native,
  convertScreenshot: async (bytes: Uint8Array, maxWidth = 0, quality?: number) => {
    conversions.push([maxWidth, quality ?? 0]);
    if (quality !== undefined && rejectJpeg) throw new Error("Injected JPEG conversion failure");
    return Buffer.concat([
      Buffer.from(bytes),
      Buffer.from(quality === undefined ? ` resized=${maxWidth}` : ` jpeg=${quality}`),
    ]);
  },
  NativeCapture: Capture,
  NativeHid: class {
    async setScreen() {}
    async supportsHingeAngle() {
      return false;
    }
    async supportsPhysicalOrientation() {
      return false;
    }
  },
}));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
const single = "11111111-1111-1111-1111-111111111111";
const unknown = "22222222-2222-2222-2222-222222222222";
const integrated = "33333333-3333-3333-3333-333333333333";
const tvOut = "44444444-4444-4444-4444-444444444444";
const integratedProfile = JSON.parse(
  readFileSync(join(import.meta.dir, "screenshot-integrated-profile.json"), "utf8"),
);
const integratedIO = readFileSync(join(import.meta.dir, "screenshot-integrated-io.txt"), "utf8");
const legacyProfile = JSON.parse(
  readFileSync(join(import.meta.dir, "screenshot-legacy-profile.json"), "utf8"),
);
const legacyIO = readFileSync(join(import.meta.dir, "screenshot-legacy-io.txt"), "utf8");
const temp = useTempStateDir();
const { simMiddleware } = await import("../../middleware");
const { retireDeviceSession, getDeviceSession } = await import("../../device-session");
const { runHostActionAsync } = await import("../../host-actions");
const probeScript = `
if [ "$SERVE_SIM_HTTP_PROBE" = "$probe" ]; then
  printf '%s\\n' "$probe" >> "$SERVE_SIM_HTTP_PROBES"
  if [ "$SERVE_SIM_HTTP_PROBE_FAILURE" = blocked ]; then
    while [ ! -f "$SERVE_SIM_HTTP_PROBE_RELEASE" ]; do sleep 0.01; done
    printf '%s released\\n' "$probe" >> "$SERVE_SIM_HTTP_PROBES"
  else
    if [ "$SERVE_SIM_HTTP_PROBE_FAILURE" = timeout ]; then exec sleep 4; fi
    exit 1
  fi
fi
`;
const shims = installShims({
  xcrun:
    '#!/bin/sh\nif [ "$*" = "simctl list -j" ]; then probe=list; ' +
    probeScript +
    'fi\nif [ "$4" = enumerate ]; then probe=enumerate; ' +
    probeScript +
    'fi\nif [ "$2" = list ]; then printf \'%s\' "$SERVE_SIM_HTTP_DEVICES"; exit 0; fi\nif [ "$4" = enumerate ]; then printf \'%s\' "$SERVE_SIM_HTTP_ENUMERATE"; exit 0; fi\nfor last; do :; done\nprintf \'%s\\n\' "$*" >> "$SERVE_SIM_HTTP_SHOTS"\nprintf \'\\211PNG\\r\\n\\032\\n%s\' "$*" > "$last"\n',
  cp: "#!/bin/sh\nexit 0\n",
  plutil: "#!/bin/sh\nprobe=plutil\n" + probeScript + 'exec cat "$5"\n',
});
const devicetypes = [
  ["fixture.single", [7]],
  ["fixture.duo", [1, 3]],
  ["fixture.tv", [2]],
].map(([identifier, ids]) => {
  const bundlePath = join(shims.dir, String(identifier) + ".simdevicetype");
  const resources = join(bundlePath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(resources, "capabilities.plist"),
    JSON.stringify({
      capabilities: {
        displays: (ids as number[]).map((screenID) => ({
          displayType: identifier === "fixture.tv" ? "tvOut" : "integrated",
          screenID,
          width: 100,
          height: 200,
        })),
      },
    }),
  );
  return { identifier, bundlePath };
});
const integratedBundle = join(shims.dir, "fixture.integrated.simdevicetype");
const integratedProfileFile = join(integratedBundle, "Contents", "Resources", "capabilities.plist");
mkdirSync(join(integratedBundle, "Contents", "Resources"), { recursive: true });
writeFileSync(integratedProfileFile, JSON.stringify(integratedProfile));
devicetypes.push({ identifier: "fixture.integrated", bundlePath: integratedBundle });
process.env.SERVE_SIM_HTTP_PROBES = join(shims.dir, "probes");
process.env.SERVE_SIM_HTTP_SHOTS = join(shims.dir, "shots");
process.env.SERVE_SIM_HTTP_DEVICES = JSON.stringify({
  devicetypes,
  devices: {
    runtime: [
      { udid: UDID, state: "Booted", name: "Renamed iPhone", deviceTypeIdentifier: "fixture.duo" },
      { udid: single, state: "Booted", name: "iPhone", deviceTypeIdentifier: "fixture.single" },
      { udid: unknown, state: "Booted", name: "iPhone", deviceTypeIdentifier: "fixture.unknown" },
      {
        udid: integrated,
        state: "Booted",
        name: "Captured iPhone",
        deviceTypeIdentifier: "fixture.integrated",
      },
      { udid: tvOut, state: "Booted", name: "TV", deviceTypeIdentifier: "fixture.tv" },
    ],
  },
});
const settings = {
  transport: "webrtc" as const,
  codec: "vp8" as const,
  h264Bitrate: 2_300_000,
  h264Fps: 24,
  maxDimension: 720,
};
const middleware = simMiddleware({
  basePath: "/preview",
  streamSettings: settings,
  corsOrigins: ["https://expo.dev"],
});
async function shot(extra = "", device = UDID) {
  return (await middleware(
    new Request(`http://localhost/preview/api/screenshot?device=${device.toLowerCase()}${extra}`, {
      method: "POST",
      headers: { origin: "https://expo.dev" },
    }),
  ))!;
}
afterEach(async () => {
  await Promise.all([UDID, single, integrated, tvOut].map(retireDeviceSession));
  writeFileSync(integratedProfileFile, JSON.stringify(integratedProfile));
  active = 1;
  sequence = [];
  startupError = undefined;
  screenshotGate = undefined;
  captures.length = 0;
  conversions.length = 0;
  nativeWidths.length = 0;
  rejectJpeg = false;
  stops = 0;
  delete process.env.SERVE_SIM_HTTP_ENUMERATE;
  delete process.env.SERVE_SIM_HTTP_PROBE;
  delete process.env.SERVE_SIM_HTTP_PROBE_FAILURE;
  delete process.env.SERVE_SIM_HTTP_PROBE_RELEASE;
});

function runtimeDisplays(ids: readonly number[]) {
  return (
    ids
      .map(
        () =>
          "Port:\n    Port Identifier: com.apple.framebuffer.display\n    Display class: 0\n    Default width: 100\n    Default height: 200\n    IOSurface port:\n        width = 100\n        height = 200\n",
      )
      .join("") +
    "Port:\n    Port Identifier: com.apple.framebuffer.server\n    Connected Screens:\n" +
    ids
      .map(
        (id) =>
          `    (${id}) fixture\n        Screen Type: Integrated\n        Screen ID: ${id}\n        Pixel Size: {100, 200}\n`,
      )
      .join("")
  );
}

test("HTTP reuses a warm native session without probing simctl", async () => {
  active = 7;
  await getDeviceSession(single, settings).start();
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
  for (const probe of ["list", "enumerate", "plutil"]) {
    writeFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "");
    process.env.SERVE_SIM_HTTP_PROBE = probe;
    const response = await shot("", single);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("native --display=7");
    expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toBe("");
  }
  expect(captures).toHaveLength(1);
});

test.each(["", "&maxWidth=50"])(
  "HTTP reuses a native session created during display verification: %s",
  async (query) => {
    active = 7;
    process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
    process.env.SERVE_SIM_HTTP_PROBE = "enumerate";
    process.env.SERVE_SIM_HTTP_PROBE_FAILURE = "blocked";
    const release = join(shims.dir, `probe-release-${crypto.randomUUID()}`);
    process.env.SERVE_SIM_HTTP_PROBE_RELEASE = release;
    writeFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "");
    writeFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "");
    const pending = shot(query, single);
    try {
      const probeReachedBy = performance.now() + 5_000;
      while (!readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")) {
        if (performance.now() > probeReachedBy) break;
        await Bun.sleep(5);
      }
      const blockedAt = performance.now();
      expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toBe("enumerate\n");
      expect(captures).toHaveLength(0);
      await getDeviceSession(single, settings).start();
      writeFileSync(release, "");
      // Releasing well inside the 2 s probe limit keeps verification successful,
      // so native bytes below come from the session recheck, not a probe fallback.
      expect(performance.now() - blockedAt).toBeLessThan(1_500);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          Buffer.from("native --display=7"),
        ]),
      );
      expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toBe(
        "enumerate\nenumerate released\n",
      );
      expect(readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8")).toBe("native --display=7\n");
      expect(captures).toHaveLength(1);
      expect(stops).toBe(0);
      expect(conversions).toEqual([]);
      expect(nativeWidths).toEqual([query ? 50 : 0]);
    } finally {
      writeFileSync(release, "");
      await pending;
    }
  },
  10_000,
);

for (const probe of ["list", "enumerate", "plutil"]) {
  test.each(["failure", "timeout"])(
    `HTTP falls through to native when ${probe} has a %s`,
    async (failure) => {
      active = 7;
      process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
      process.env.SERVE_SIM_HTTP_PROBE = probe;
      process.env.SERVE_SIM_HTTP_PROBE_FAILURE = failure;
      writeFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "");
      const started = performance.now();
      const response = await shot("", single);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("native --display=7");
      expect(captures).toHaveLength(1);
      expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toContain(probe);
      expect(performance.now() - started).toBeLessThan(3_500);
    },
  );
}

test("HTTP falls through to native when legacy enumeration times out", async () => {
  writeFileSync(
    integratedProfileFile,
    JSON.stringify({
      capabilities: {
        idiom: "phone",
        ScreenDimensionsCapability: { "main-screen-width": 100, "main-screen-height": 200 },
      },
    }),
  );
  active = 1;
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([1]);
  process.env.SERVE_SIM_HTTP_PROBE = "enumerate";
  process.env.SERVE_SIM_HTTP_PROBE_FAILURE = "timeout";
  writeFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "");
  const started = performance.now();
  const response = await shot("", integrated);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("native --display=1");
  expect(captures).toHaveLength(1);
  expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toContain("enumerate");
  expect(performance.now() - started).toBeLessThan(3_500);
});

test("HTTP captures a verified sole screen without starting native video", async () => {
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
  startupError = new Error("Native video must not start for a sole screen PNG");
  const response = await shot("", single);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("--display=7");
  expect(captures).toHaveLength(0);
});

test.each([{ ids: [9] }, { ids: [7, 9] }])(
  "HTTP retains native election when runtime screens disagree: %j",
  async ({ ids }) => {
    process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays(ids);
    active = 7;
    const response = await shot("", single);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("--display=7");
    expect(captures).toHaveLength(1);
  },
);
afterAll(() => {
  shims.restore();
  temp.restore();
  delete process.env.SERVE_SIM_HTTP_SHOTS;
  delete process.env.SERVE_SIM_HTTP_DEVICES;
  delete process.env.SERVE_SIM_HTTP_PROBES;
});

test.each(["startup", "readback"])(
  "a single-display device uses simctl if native %s is unavailable",
  async (failure) => {
    if (failure === "startup") startupError = new Error("Native addon missing");
    else active = new Error("Native display readback unavailable");
    const res = await shot("", single);
    expect(res.status).toBe(200);
    const png = await res.text();
    expect(png).toContain(`simctl io ${single} screenshot`);
    expect(png).toContain("--display=7");
    expect((await shot()).status).toBe(500);
    expect((await shot("", unknown)).status).toBe(500);
  },
);

test("HTTP screenshots select the active cover or inner panel with trusted startup settings", async () => {
  for (const id of [1, 3, 1]) {
    active = id;
    const res = await shot();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://expo.dev");
    expect(await res.text()).toContain(`--display=${id}`);
  }
  expect(captures).toHaveLength(3);
  for (let i = 0; i < 100 && stops < 3; i++) await Bun.sleep(5);
  expect(stops).toBe(3);
  expect(captures[0]?.udid).toBe(UDID);
  expect(captures[0]?.settings).toMatchObject({
    h264Bitrate: 2_300_000,
    h264Fps: 24,
    maxDimension: 720,
  });
});
test("HTTP recaptures a panel switch and bounds an unstable fold", async () => {
  sequence = [1, 3, 3];
  const stable = await shot();
  expect(stable.status).toBe(200);
  expect(await stable.text()).toContain("--display=3");
  sequence = [1, 3, 1, 3];
  const unstable = await shot();
  expect(unstable.status).toBe(500);
  expect(await unstable.json()).toEqual({
    ok: false,
    error: "The active display kept changing. Retry the screenshot once the fold has finished.",
  });
});
test("HTTP screenshots expose capture and artifact timing for native and explicit displays", async () => {
  for (const query of ["", "&display=3"]) {
    const response = await shot(query);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-expose-headers")).toContain("Server-Timing");
    const timings = Object.fromEntries(
      response.headers
        .get("server-timing")!
        .split(",")
        .map((entry) => {
          const [name, duration] = entry.trim().split(";dur=");
          return [name, Number(duration)];
        }),
    );
    for (const name of ["total", "capture", "native", "artifact"]) {
      expect(Number.isFinite(timings[name])).toBe(true);
      expect(timings[name]).toBeGreaterThanOrEqual(0);
    }
    expect(timings.total).toBeGreaterThanOrEqual(timings.capture);
    expect(timings.capture).toBeGreaterThanOrEqual(timings.native);
    if (query) expect(timings.native).toBe(0);
  }
});
test("HTTP explicit display avoids native startup and rejects invalid IDs", async () => {
  startupError = new Error("Must not start capture");
  const explicit = await shot("&display=3");
  expect(explicit.status).toBe(200);
  expect(await explicit.text()).toContain("--display=3");
  expect(captures).toHaveLength(0);
  for (const display of ["0", "-1", "1.5", "wrong", "4294967296"])
    expect((await shot(`&display=${display}`)).status).toBe(400);
});
test("HTTP and host action surface real session startup failure before simctl", async () => {
  startupError = new Error("Native capture startup failed");
  const before = readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8");
  expect((await shot()).status).toBe(500);
  const result = await runHostActionAsync(
    { action: "screenshot.capture", params: { udid: UDID } },
    "true",
    settings,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    stderr:
      "Could not start screenshot capture. Check that the simulator is booted and check the host logs.",
  });
  expect(readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8")).toBe(before);
});
test("HTTP fails explicitly when the native active display is unknown", async () => {
  active = new Error("Simulator did not report its active display");
  expect((await shot()).status).toBe(500);
});

test("HTTP startup errors keep private addon paths in host logs", async () => {
  startupError = new Error("dlopen /Users/private/build/serve-sim-native.node failed");
  const res = await shot();
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ ok: false, error: "Simulator screenshot failed" });
});

test("HTTP capture keeps its five-second deadline and retains native work until it drains", async () => {
  let release!: () => void;
  screenshotGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const response = await Promise.race([
      shot(),
      Bun.sleep(8000).then(() => {
        throw new Error("HTTP screenshot did not honor its deadline");
      }),
    ]);
    expect(response.status).toBe(500);
    expect(stops).toBe(0);
  } finally {
    release();
  }
  for (let i = 0; i < 400 && !stops; i++) await Bun.sleep(5);
  expect(stops).toBe(1);
}, 10_000);

test("HTTP captures the real integrated panel with auxiliary outputs without native startup", async () => {
  process.env.SERVE_SIM_HTTP_ENUMERATE = integratedIO;
  startupError = new Error("Native video must not start for the verified integrated panel");
  const response = await shot("", integrated);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("--display=1");
  expect(captures).toHaveLength(0);
});

test("HTTP keeps a strict sole TVOut capture available without an integrated IOSurface", async () => {
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([2])
    .replace("Display class: 0", "Display class: 1")
    .replace("Screen Type: Integrated", "Screen Type: TVOut")
    .replace("IOSurface port:", "Unavailable surface:");
  startupError = new Error("A sole TVOut PNG needs no native stream");
  const response = await shot("", tvOut);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("--display=2");
  expect(captures).toHaveLength(0);
});

for (const [name, io] of [
  [
    "missing legacy surface",
    runtimeDisplays([1]).replace("IOSurface port:", "Unavailable surface:"),
  ],
  ["mismatched legacy surface", runtimeDisplays([1]).replace("width = 100", "width = 999")],
] as const) {
  test(`HTTP retains native election for ${name}`, async () => {
    writeFileSync(
      integratedProfileFile,
      JSON.stringify({
        capabilities: {
          idiom: "phone",
          ScreenDimensionsCapability: { "main-screen-width": 100, "main-screen-height": 200 },
        },
      }),
    );
    process.env.SERVE_SIM_HTTP_ENUMERATE = io;
    active = 1;
    const response = await shot("", integrated);
    expect(response.status).toBe(200);
    expect(captures).toHaveLength(1);
  });
}

for (const [name, io] of [
  ["integrated instead of TVOut", runtimeDisplays([2])],
  [
    "CarPlay instead of TVOut",
    runtimeDisplays([2])
      .replace("Display class: 0", "Display class: 1")
      .replace("Screen Type: Integrated", "Screen Type: CarPlay"),
  ],
] as const) {
  test(`HTTP retains native election for ${name}`, async () => {
    process.env.SERVE_SIM_HTTP_ENUMERATE = io;
    active = 2;
    const response = await shot("", tvOut);
    expect(response.status).toBe(200);
    expect(captures).toHaveLength(1);
  });
}

test("HTTP bypasses native startup for a verified legacy integrated surface", async () => {
  writeFileSync(
    integratedProfileFile,
    JSON.stringify({
      capabilities: {
        idiom: "phone",
        ScreenDimensionsCapability: { "main-screen-width": 100, "main-screen-height": 200 },
      },
    }),
  );
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([1]);
  startupError = new Error("A verified legacy surface needs no native stream");
  const response = await shot("", integrated);
  expect(response.status).toBe(200);
  expect(captures).toHaveLength(0);
});

test.each(["TVOut", "CarPlay"])(
  "HTTP captures the real Xcode 26.6 legacy panel with %s without native startup",
  async (auxiliary) => {
    writeFileSync(integratedProfileFile, JSON.stringify(legacyProfile));
    process.env.SERVE_SIM_HTTP_ENUMERATE = legacyIO.replace(
      "Screen Type: TVOut",
      `Screen Type: ${auxiliary}`,
    );
    startupError = new Error(
      "A verified legacy panel with known auxiliary output needs no native stream",
    );
    const response = await shot("", integrated);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`simctl io ${integrated} screenshot --display=1`);
    expect(captures).toHaveLength(0);
  },
);

for (const [name, io] of [
  ["two integrated ports", legacyIO.replace("Display class: 1", "Display class: 0")],
  ["two integrated screens", legacyIO.replace("Screen Type: TVOut", "Screen Type: Integrated")],
  ["unknown auxiliary class", legacyIO.replace("Display class: 1", "Display class: 2")],
  ["unknown auxiliary type", legacyIO.replace("Screen Type: TVOut", "Screen Type: Unknown")],
  ["duplicate legacy ID", legacyIO.replace("Screen ID: 2", "Screen ID: 1")],
  ["missing legacy IOSurface", legacyIO.replace("IOSurface port:", "Unavailable surface:")],
  [
    "mismatched legacy IOSurface",
    legacyIO.replace("width              = 1206", "width              = 999"),
  ],
] as const) {
  test(`HTTP retains native election with legacy auxiliary outputs and ${name}`, async () => {
    writeFileSync(integratedProfileFile, JSON.stringify(legacyProfile));
    process.env.SERVE_SIM_HTTP_ENUMERATE = io;
    active = 1;
    const response = await shot("", integrated);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("native --display=1");
    expect(captures).toHaveLength(1);
  });
}

for (const [name, io] of [
  ["missing IOSurface", integratedIO.replace("IOSurface port:", "Unavailable surface:")],
  [
    "duplicate screen ID",
    integratedIO.replace("Screen ID: 1\n", "Screen ID: 1\n        Screen ID: 9\n"),
  ],
  [
    "duplicate display class",
    integratedIO.replace("Display class: 0\n", "Display class: 0\n        Display class: 1\n"),
  ],
  [
    "duplicate default width",
    integratedIO.replace(
      "Default width: 1206\n",
      "Default width: 1206\n        Default width: 999\n",
    ),
  ],
  ["different integrated ID", integratedIO.replace("Screen ID: 1\n", "Screen ID: 9\n")],
  ["default size mismatch", integratedIO.replace("Default width: 1206", "Default width: 999")],
  [
    "surface size mismatch",
    integratedIO.replace("width              = 1206", "width              = 999"),
  ],
  [
    "connected size mismatch",
    integratedIO.replace("Pixel Size: {1206, 2622}", "Pixel Size: {999, 2622}"),
  ],
  ["unknown framebuffer class", integratedIO.replace("Display class: 1", "Display class: 2")],
  ["unknown auxiliary screen", integratedIO.replace("Screen Type: Scene", "Screen Type: Unknown")],
  ["two integrated framebuffers", integratedIO.replace("Display class: 1", "Display class: 0")],
  [
    "two integrated connected screens",
    integratedIO.replace("Screen Type: Scene", "Screen Type: Integrated"),
  ],
] as const) {
  test(`HTTP retains native election for ${name}`, async () => {
    process.env.SERVE_SIM_HTTP_ENUMERATE = io;
    active = 1;
    const response = await shot("", integrated);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("--display=1");
    expect(captures).toHaveLength(1);
  });
}

test("HTTP never infers the active foldable panel from one actual IOSurface", async () => {
  const profile = structuredClone(integratedProfile);
  profile.capabilities.displays.push({ ...profile.capabilities.displays[0], screenID: 9 });
  writeFileSync(integratedProfileFile, JSON.stringify(profile));
  process.env.SERVE_SIM_HTTP_ENUMERATE = integratedIO;
  active = 1;
  const response = await shot("", integrated);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("--display=1");
  expect(captures).toHaveLength(1);
});

test("HTTP retains native election for an unknown profile output type", async () => {
  const profile = structuredClone(integratedProfile);
  profile.capabilities.displays.find(
    (display: { displayType: string }) => display.displayType === "scene",
  ).displayType = "unknown";
  writeFileSync(integratedProfileFile, JSON.stringify(profile));
  process.env.SERVE_SIM_HTTP_ENUMERATE = integratedIO;
  active = 1;
  const response = await shot("", integrated);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("--display=1");
  expect(captures).toHaveLength(1);
});

test("HTTP captures a verified sole screen with image options without starting native video", async () => {
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
  startupError = new Error("Native video must not start for sole-screen image options");
  const directory = mkdtempSync(join(tmpdir(), "sole-display-options-"));
  const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
  process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = directory;
  try {
    const resized = await shot("&maxWidth=50", single);
    expect(resized.status).toBe(200);
    expect(resized.headers.get("content-type")).toBe("image/png");
    const body = Buffer.from(await resized.arrayBuffer());
    expect(body.toString()).toContain("--display=7");
    expect(body.toString().endsWith(" resized=50")).toBe(true);
    expect(conversions).toEqual([[50, 0]]);
    expect(captures).toHaveLength(0);
    expect(resized.headers.get("content-length")).toBe(String(body.byteLength));
    expect(resized.headers.get("server-timing")).toContain("native;dur=0.000");
    conversions.length = 0;

    const jpeg = await shot("&maxWidth=50&format=jpeg&quality=65", single);
    expect(jpeg.status).toBe(200);
    expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
    expect(conversions).toEqual([
      [50, 0],
      [0, 65],
    ]);
    expect((await jpeg.text()).endsWith(" jpeg=65")).toBe(true);
    const artifacts = readdirSync(directory)
      .filter((name) => name.endsWith(".png"))
      .sort((a, b) => statSync(join(directory, b)).mtimeMs - statSync(join(directory, a)).mtimeMs);
    expect(artifacts).toHaveLength(2);
    const artifact = readFileSync(join(directory, artifacts[0]!), "utf8");
    expect(artifact).toContain("--display=7");
    expect(artifact.endsWith(" resized=50")).toBe(true);
    expect(artifact).not.toContain("jpeg=");
    conversions.length = 0;

    const defaultJpeg = await shot("&format=jpeg", single);
    expect(defaultJpeg.status).toBe(200);
    expect(conversions).toEqual([[0, 80]]);
  } finally {
    if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
    else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP passes image options to a warm native session without probes", async () => {
  active = 7;
  await getDeviceSession(single, settings).start();
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
  process.env.SERVE_SIM_HTTP_PROBE = "list";
  writeFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "");
  const response = await shot("&maxWidth=50&format=jpeg&quality=65", single);
  expect(response.status).toBe(200);
  expect(nativeWidths).toEqual([50]);
  expect(conversions).toEqual([[0, 65]]);
  expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toBe("");
});

test("HTTP rejects invalid image options and displays before any probe", async () => {
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
  for (const probe of ["list", "enumerate", "plutil"]) {
    for (const query of ["&maxWidth=0", "&format=gif", "&quality=101", "&display=0"]) {
      writeFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "");
      process.env.SERVE_SIM_HTTP_PROBE = probe;
      const shots = readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8");
      expect((await shot(query, single)).status).toBe(400);
      expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toBe("");
      expect(readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8")).toBe(shots);
      expect(captures).toHaveLength(0);
    }
  }
  process.env.SERVE_SIM_HTTP_PROBE = "list";
  active = 7;
  // Native failure also reaches the detector before the cold-session shortcut exists.
  startupError = new Error("Exercise the probe detector through the existing fallback");
  await shot("", single);
  expect(readFileSync(process.env.SERVE_SIM_HTTP_PROBES!, "utf8")).toContain("list");
});

test("HTTP sole-display JPEG conversion failure saves no artifact", async () => {
  process.env.SERVE_SIM_HTTP_ENUMERATE = runtimeDisplays([7]);
  const directory = mkdtempSync(join(tmpdir(), "sole-display-jpeg-failure-"));
  const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
  process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = directory;
  rejectJpeg = true;
  startupError = new Error("Sole-display JPEG capture needs no native video");
  const before = readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8");
  try {
    expect((await shot("&format=jpeg", single)).status).toBe(500);
    expect(readdirSync(directory)).toEqual([]);
    const shots = readFileSync(process.env.SERVE_SIM_HTTP_SHOTS!, "utf8");
    expect(shots.slice(before.length)).toContain(`simctl io ${single} screenshot --display=7`);
  } finally {
    if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
    else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
