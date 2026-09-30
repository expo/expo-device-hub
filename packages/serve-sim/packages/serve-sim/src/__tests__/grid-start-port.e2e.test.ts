import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { request } from "http";
import { join } from "path";

import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";

const CLI = join(import.meta.dir, "../..", "dist/serve-sim.js");
// A tunnel forwards the public host, which carries no port.
const TUNNEL_HOST = "web-preview-e2e.eas-simulator.ngrok.dev";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI);
requireE2E("grid start behind a tunnel", ready);

const describeOrSkip = ready ? describe : describe.skip;

async function waitForAsync(check: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(250);
  expect(check()).toBe(true);
}

// fetch cannot set Host, so this sends the tunnel's Host header with http.request.
function postThroughTunnelHost(port: number, path: string, token: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Host: TUNNEL_HOST,
          Origin: `https://${TUNNEL_HOST}`,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describeOrSkip("grid start behind a tunnel", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let server: ChildProcess | undefined;
  let port = 0;
  let stderr = "";
  const stateFile = () => join(tempState.dir, `server-${udid!}.json`);

  beforeAll(async () => {
    tempState = useTempStateDir();
    killHelpersForDevice(udid!);
    port = await freePortAsync();
    server = spawn("node", [CLI, "--require-token", "--quiet", "--port", String(port), udid!], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await waitForAsync(() => existsSync(stateFile()));
  }, 120_000);

  afterAll(async () => {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          server?.kill("SIGKILL");
          done();
        }, 30_000);
        server!.on("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    tempState?.restore();
  }, 60_000);

  test("keeps the server's own port in the device state", async () => {
    const { token } = JSON.parse(readFileSync(stateFile(), "utf-8")) as { token: string };

    const status = await postThroughTunnelHost(port, "/grid/api/start", token, { udid });

    expect(status, stderr).toBe(200);
    const state = JSON.parse(readFileSync(stateFile(), "utf-8")) as { url: string; port: number };
    expect(state.url).toBe(`http://127.0.0.1:${port}`);
    expect(state.port).toBe(port);
  }, 240_000);
});
