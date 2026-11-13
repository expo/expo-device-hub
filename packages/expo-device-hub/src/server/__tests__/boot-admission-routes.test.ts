/// <reference types="bun" />

/**
 * Admission of the vendored servers' start routes: serve-sim `grid/api/start`
 * and serve-emu `api/avds/start`. The gate is tested here with a fake server;
 * the fixture checks that the Hub's real handlers route both through it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BootAdmissionHost,
  type NativeOccupancy,
  createBootAdmission,
} from "../boot-admission";
import {
  type VendorStartRoute,
  admitVendorStart,
  serveEmuStartRoute,
  serveSimStartRoute,
} from "../vendor-boot-gate";
import { fakeProcessTable } from "./fixtures/boot-admission-fake-host";

const SIM_START = "/vendor/serve-sim/grid/api/start";
const EMU_START = "/vendor/serve-emu/api/avds/start";
const PAGE = "https://page.example";
const OTHER_PAGE = "https://elsewhere.example";
const allowsPage = (origin: URL): boolean => origin.origin === PAGE;
const simRoute = serveSimStartRoute("/vendor/serve-sim", allowsPage);
const emuRoute = serveEmuStartRoute("/vendor/serve-emu", allowsPage);

const X = "11111111-1111-1111-1111-111111111111";
const Y = "22222222-2222-2222-2222-222222222222";

let dir: string;
let policyFile: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boot-admission-routes-"));
  mkdirSync(join(dir, "device-hub"));
  policyFile = join(dir, "device-hub", "host-policy.json");
  stateDir = join(dir, "device-hub", "boot-admission");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface FakeHost extends BootAdmissionHost {
  reads: number;
  /** Command lines of the processes besides this test process. */
  processes: Map<number, string>;
}

function host(occupancy: Partial<NativeOccupancy> = {}): FakeHost {
  const fake: FakeHost = {
    reads: 0,
    processes: new Map(),
    async readOccupancy() {
      fake.reads++;
      return { value: { simulators: [], androidDevices: [], ...occupancy }, error: null };
    },
    async readProcesses() {
      return {
        value: fakeProcessTable([[process.pid, "bun test"], ...fake.processes]),
        error: null,
      };
    },
    pidExists: (pid) => pid === process.pid || fake.processes.has(pid),
  };
  return fake;
}

/** A fake server that records what reached it. */
function server(answer: () => Response = () => Response.json({ ok: true })) {
  const received: { request: Request; body: string }[] = [];
  return {
    received,
    async forward(request: Request): Promise<Response> {
      received.push({ request, body: await request.text() });
      return answer();
    },
  };
}

function start(path: string, body: string, origin?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body,
  });
}

function cors(response: Response | null) {
  return {
    allowOrigin: response?.headers.get("access-control-allow-origin") ?? null,
    vary: response?.headers.get("vary") ?? null,
  };
}

function records(): Record<string, unknown>[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((name) => /^attempt-.*\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(stateDir, name), "utf8")));
}

async function gate(route: VendorStartRoute, request: Request, fakeHost = host()) {
  const backend = server(() =>
    Response.json({ ok: true, serial: "emulator-5560", avd: "Pixel_9" }),
  );
  const admission = createBootAdmission({ policyFile, stateDir, host: fakeHost });
  const response = await admitVendorStart(request, route, backend.forward, admission);
  return { response, received: backend.received };
}

describe("without a host policy", () => {
  test.each([
    ["serve-sim", simRoute, SIM_START, JSON.stringify({ udid: X })],
    ["serve-emu", emuRoute, EMU_START, JSON.stringify({ avd: "Pixel_9" })],
  ] as const)("%s start is forwarded untouched", async (_, route, path, body) => {
    const original = start(path, body);
    const fakeHost = host();

    const { received } = await gate(route, original, fakeHost);

    expect(received).toHaveLength(1);
    expect(received[0]!.request).toBe(original);
    expect(received[0]!.body).toBe(body);
    expect(fakeHost.reads).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe("with a host policy of one", () => {
  beforeEach(() => {
    writeFileSync(policyFile, JSON.stringify({ maxVirtualDevices: 1 }));
  });

  test("a serve-sim start of a different simulator is refused and not forwarded", async () => {
    const booted = host({ simulators: [{ udid: X, name: "iPhone", state: "Booted" }] });

    const { response, received } = await gate(
      simRoute,
      start(SIM_START, JSON.stringify({ udid: Y })),
      booted,
    );

    expect(received).toEqual([]);
    expect(response?.status).toBe(500);
    const body = await response!.json();
    expect(body.ok).toBe(false);
    expect(body.error).toStartWith("Device host capacity reached: 1 of 1");
  });

  test("a serve-emu start of a different AVD is refused and not forwarded", async () => {
    const running = host({
      androidDevices: [{ serial: "emulator-5554", state: "device", avdName: "Pixel_9" }],
    });

    const { response, received } = await gate(
      emuRoute,
      start(EMU_START, JSON.stringify({ avd: "Pixel_8" })),
      running,
    );

    expect(received).toEqual([]);
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false });
  });

  test("a start of a counted device passes with the same body and no record", async () => {
    const body = JSON.stringify({ udid: X, extra: "ü" });
    const booted = host({ simulators: [{ udid: X, name: "iPhone", state: "Booted" }] });

    const { response, received } = await gate(simRoute, start(SIM_START, body), booted);

    expect(response?.status).toBe(200);
    expect(received.map((entry) => entry.body)).toEqual([body]);
    expect(received[0]!.request.headers.get("content-type")).toBe("application/json");
    expect(records()).toEqual([]);
  });

  test("an admitted emulator start records the serial the server answered", async () => {
    const { response, received } = await gate(
      emuRoute,
      start(EMU_START, JSON.stringify({ avd: "Pixel_9" })),
    );

    expect(await response!.json()).toMatchObject({ ok: true, serial: "emulator-5560" });
    expect(received).toHaveLength(1);
    expect(records()).toEqual([
      expect.objectContaining({
        platform: "android",
        avdName: "Pixel_9",
        serial: "emulator-5560",
        finished: true,
      }),
    ]);
  });

  test("an emulator start that failed without a pid keeps its slot while the emulator runs", async () => {
    const fakeHost = host();
    const admission = createBootAdmission({ policyFile, stateDir, host: fakeHost });
    // serve-emu spawned the emulator, then its start failed before adb listed it.
    const failing = server(() => {
      fakeHost.processes.set(4_100_001, "emulator @Pixel_9 -port 5556");
      return Response.json({ ok: false, error: "emulator did not boot" }, { status: 400 });
    });
    await admitVendorStart(
      start(EMU_START, JSON.stringify({ avd: "Pixel_9" })),
      emuRoute,
      failing.forward,
      admission,
    );
    expect(records()).toEqual([expect.objectContaining({ avdName: "Pixel_9", finished: true })]);

    const { response, received } = await gate(
      emuRoute,
      start(EMU_START, JSON.stringify({ avd: "Pixel_8" })),
      fakeHost,
    );
    expect(received).toEqual([]);
    expect((await response!.json()).error).toStartWith("Device host capacity reached: 1 of 1");

    fakeHost.processes.delete(4_100_001);
    const admitted = await gate(
      emuRoute,
      start(EMU_START, JSON.stringify({ avd: "Pixel_8" })),
      fakeHost,
    );
    expect(admitted.received).toHaveLength(1);
  });

  test("a malformed body is forwarded for the server to reject", async () => {
    const { received } = await gate(simRoute, start(SIM_START, "{"));

    expect(received.map((entry) => entry.body)).toEqual(["{"]);
    expect(records()).toEqual([]);
  });

  test("other requests to the server are forwarded untouched", async () => {
    const original = start("/vendor/serve-sim/grid/api/shutdown", JSON.stringify({ udid: Y }));
    const fakeHost = host();

    const { received } = await gate(simRoute, original, fakeHost);

    expect(received[0]!.request).toBe(original);
    expect(fakeHost.reads).toBe(0);
  });

  test("an oversized body is refused and not forwarded", async () => {
    const { response, received } = await gate(
      simRoute,
      start(SIM_START, JSON.stringify({ udid: X, pad: "x".repeat(70_000) })),
    );

    expect(response?.status).toBe(413);
    expect(received).toEqual([]);
  });

  // A page the server lets read its answers reads the Hub's refusal too, not a network error.
  test.each([
    ["serve-sim", simRoute, SIM_START, { udid: Y }, 500],
    ["serve-emu", emuRoute, EMU_START, { avd: "Pixel_8" }, 400],
  ] as const)(
    "a %s capacity refusal carries the server's CORS headers",
    async (_, route, path, body, status) => {
      const full = host({ simulators: [{ udid: X, name: "iPhone", state: "Booted" }] });

      const allowed = await gate(route, start(path, JSON.stringify(body), PAGE), full);
      const other = await gate(route, start(path, JSON.stringify(body), OTHER_PAGE), full);

      expect(allowed.response?.status).toBe(status);
      expect(cors(allowed.response)).toEqual({ allowOrigin: PAGE, vary: "Origin" });
      expect(other.response?.status).toBe(status);
      expect(cors(other.response)).toEqual({ allowOrigin: null, vary: "Origin" });
    },
  );

  test.each([
    ["serve-sim", simRoute, SIM_START],
    ["serve-emu", emuRoute, EMU_START],
  ] as const)("a %s 413 carries the server's CORS headers", async (_, route, path) => {
    const oversized = JSON.stringify({ pad: "x".repeat(70_000) });

    const allowed = await gate(route, start(path, oversized, PAGE));
    const other = await gate(route, start(path, oversized, OTHER_PAGE));

    expect(allowed.response?.status).toBe(413);
    expect(cors(allowed.response)).toEqual({ allowOrigin: PAGE, vary: "Origin" });
    expect(cors(other.response)).toEqual({ allowOrigin: null, vary: "Origin" });
  });
});

test("the Hub's serve-sim and serve-emu handlers gate their start routes", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", "./fixtures/boot-admission-routes.fixture.ts"],
    { cwd: import.meta.dir, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(`${stdout}\n${stderr}`).toContain(" 0 fail");
  expect(`${stdout}\n${stderr}`).toContain(" 5 pass");
  expect(exitCode).toBe(0);
});
