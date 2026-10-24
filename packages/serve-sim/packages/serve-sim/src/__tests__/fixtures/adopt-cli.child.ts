import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { inProcessServeSimState, stateDir, writeServeSimState } from "../../state";
import { useTempStateDir, withShimsAsync } from "../helpers";
import { sessionEnvironment, startSessionOwner, type SessionIdentity } from "../../session-owner";

const UDID = "11111111-2222-3333-4444-555555555555";
const bundleDir = mkdtempSync(join(tmpdir(), "serve-sim-adopt-cli-"));
let entrypoint: string;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../index.ts")],
    outdir: join(bundleDir, "dist"),
    naming: "[name].mjs",
    target: "node",
  });
  if (!build.success) throw new AggregateError(build.logs, "CLI fixture build failed");
  entrypoint = build.outputs[0]!.path;
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

async function fixture(
  run: (value: {
    cli(
      args?: string[],
      env?: Record<string, string | undefined>,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    bodies: unknown[];
    identity: Record<string, unknown>;
    port: number;
  }) => Promise<void>,
) {
  const state = useTempStateDir();
  const bodies: unknown[] = [];
  const identity: Record<string, unknown> = {
    version: "0.0.0",
    pid: process.pid,
    device: UDID,
    bootSession: execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
    }).trim(),
    host: "127.0.0.1",
    port: 0,
    stateDirectory: resolve(stateDir()),
    temporaryDirectory: resolve(tmpdir()),
    environment: sessionEnvironment(),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      throw new Error("Adoption must never contact the HTTP server");
    },
  });
  identity.port = server.port;
  writeServeSimState({ ...inProcessServeSimState(UDID, server.port!), token: "owner-token" });
  const owner = await startSessionOwner(
    UDID,
    () => identity as unknown as SessionIdentity,
    async (configuration) => {
      bodies.push(configuration);
    },
  );
  const calls = join(state.dir, "native-calls");
  try {
    await withShimsAsync(
      { xcrun: `#!/bin/sh\necho native-called >> '${calls}'\nexit 99\n` },
      async () => {
        await run({
          bodies,
          identity,
          port: server.port!,
          async cli(args = [], env = {}) {
            const child = Bun.spawn(
              [
                "node",
                entrypoint,
                UDID,
                "--adopt",
                "--quiet",
                "--require-token",
                "--transport",
                "webrtc",
                ...args,
              ],
              {
                env: { ...process.env, ...env },
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
            try {
              const [exitCode, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ]);
              return { exitCode, stdout, stderr };
            } finally {
              clearTimeout(timer);
              child.kill("SIGKILL");
              await child.exited;
            }
          },
        });
        expect(() => readFileSync(calls)).toThrow();
      },
    );
  } finally {
    owner.close();
    server.stop(true);
    state.restore();
  }
}

test("real CLI adopts using the normal startup flags and screenshot environment without device commands", async () => {
  await fixture(async ({ cli, bodies, port }) => {
    const result = await cli(
      [
        "--port",
        String(port),
        "--turn-url",
        "turn:relay.example:3478",
        "--turn-username",
        "job",
        "--turn-credential",
        "secret",
        "--network-capture-proxy",
        "http://user:pass@proxy.example:8080",
        "--network-capture",
        "--network-capture-field",
        "header,query",
        "--video-fps",
        "30",
        "--video-bitrate",
        "2000000",
        "--max-dimension",
        "900",
        "--cors-origin",
        "https://*.expo.dev",
        "--frame-ancestor",
        "https://*.expo.dev",
        "--share-url",
        "https://expo.dev/job",
      ],
      { EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY: "/tmp/owned-job" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ device: UDID, port, token: "owner-token" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      networkCapture: true,
      networkCaptureProxy: "http://user:pass@proxy.example:8080",
      networkCaptureFields: ["header", "query"],
      screenshotsDirectory: "/tmp/owned-job",
      stream: {
        transport: "webrtc",
        codec: "h264",
        h264Fps: 30,
        h264Bitrate: 2000000,
        maxDimension: 900,
        iceServers: [{ urls: ["turn:relay.example:3478"], username: "job", credential: "secret" }],
      },
    });
  });
});

test.each([
  "version",
  "pid",
  "device",
  "bootSession",
  "host",
  "port",
  "stateDirectory",
  "temporaryDirectory",
  "environment",
])("refuses incompatible %s before applying any job settings", async (key) => {
  await fixture(async ({ cli, bodies, identity }) => {
    identity[key] =
      key === "environment" ? { SERVE_SIM_ACTION_TIMEOUT_MS: "other" } : "incompatible";
    const result = await cli();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("incompatible");
    expect(bodies).toHaveLength(0);
  });
});

test.each([
  "--kill",
  "--list",
  "--detach",
  "--no-preview",
  "--debug-stream",
  "--install-app-path",
  "--launch-app-identifier",
  "--enable",
  "--disable",
  "--allow-any-host-when-insecure",
])("rejects --adopt with %s before executing its normal operation", async (flag) => {
  await fixture(async ({ cli, bodies }) => {
    const needsValue = [
      "--debug-stream",
      "--install-app-path",
      "--launch-app-identifier",
      "--enable",
      "--disable",
    ].includes(flag);
    const result = await cli([flag, ...(needsValue ? ["ignored"] : [])]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("startup-only");
    expect(bodies).toHaveLength(0);
  });
});

test("uses normal encoder defaults and explicitly resets preparation capture policy", async () => {
  await fixture(async ({ cli, bodies }) => {
    expect((await cli()).exitCode).toBe(0);
    expect(bodies[0]).toMatchObject({
      stream: {
        transport: "webrtc",
        codec: "h264",
        mjpegFps: 60,
        mjpegQuality: 0.7,
        maxDimension: 0,
        h264Bitrate: 6000000,
        h264Fps: 60,
      },
      networkCapture: false,
      networkCaptureFields: [],
      corsOrigins: [],
      frameAncestors: [],
      disableShare: false,
    });
  });
});

test("never silently adopts with a boot-time dylib or a process-only env override", async () => {
  await fixture(async ({ cli, bodies }) => {
    expect((await cli([], { SERVE_SIM_ADDITIONAL_DYLIBS: "/caller.dylib" })).exitCode).toBe(1);
    expect((await cli([], { SERVE_SIM_ACTION_TIMEOUT_MS: "5" })).exitCode).toBe(1);
    expect(bodies).toHaveLength(0);
  });
});

test("matching code can adopt across image package selectors and explicit default state paths", async () => {
  const before = process.env.SERVE_SIM_VERSION;
  process.env.SERVE_SIM_VERSION = "image-package-selector";
  try {
    await fixture(async ({ cli, bodies, identity }) => {
      // The guest may use the default path implicitly; build-tools supplies the same path explicitly.
      identity.environment = Object.fromEntries(
        Object.entries(identity.environment as Record<string, string>).filter(
          ([key]) => key !== "SERVE_SIM_VERSION" && key !== "SERVE_SIM_STATE_DIR",
        ),
      );
      expect(
        (
          await cli([], {
            SERVE_SIM_VERSION: undefined,
            SERVE_SIM_STATE_DIR: String(identity.stateDirectory),
          })
        ).exitCode,
      ).toBe(0);
      expect(bodies).toHaveLength(1);
    });
  } finally {
    if (before === undefined) delete process.env.SERVE_SIM_VERSION;
    else process.env.SERVE_SIM_VERSION = before;
  }
});
