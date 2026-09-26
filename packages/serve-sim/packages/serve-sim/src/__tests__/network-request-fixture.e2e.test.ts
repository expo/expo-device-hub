import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import { join } from "path";
import WebSocket from "ws";

import type { HarEntry } from "../capture/har";
import { locateMitmdump } from "../capture/mitm-engine";
import { simctlSync } from "../simctl";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimNetworkRequestFixture.app");
const DYLIB = join(PKG_DIR, "dist/simnet/libSimNetProxy.dylib");
const APP = "dev.expo.serve-sim.network-request-fixture";
const ORIGIN_ENV = "SERVE_SIM_NETWORK_FIXTURE_ORIGIN";
const PROFILE_PATH = "/api/profile?source=button";
const TRIGGER_PROFILE_PATH = "/api/profile?source=trigger";
const UPLOAD_PATH = "/api/upload";
const UPLOAD_BYTES = 3 * 1024 * 1024;
const CAPTURED_BODY_BYTES = 512 * 1024;

const udid = e2eDevice();
const ready =
  udid !== null
  && existsSync(CLI)
  && existsSync(FIXTURE)
  && existsSync(DYLIB)
  && locateMitmdump() !== null;
requireE2E("network request fixture", ready);

type ReceivedRequest = { method: string; url: string; bodyBytes: number; bodyStart: string };
type AxNode = {
  AXUniqueId: string | null;
  frame: { x: number; y: number; width: number; height: number };
  children: AxNode[];
};

async function waitForAsync(check: () => boolean | Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(250);
  expect(await check()).toBe(true);
}

const describeOrSkip = ready ? describe : describe.skip;

describeOrSkip("network request fixture", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let origin: Server | undefined;
  let server: ChildProcess | undefined;
  let serverPort = 0;
  let originPort = 0;
  let stderr = "";
  const received: ReceivedRequest[] = [];

  beforeAll(async () => {
    tempState = useTempStateDir();
    killHelpersForDevice(udid!);

    try {
      simctlSync(["uninstall", udid!, APP]);
    } catch {}
    simctlSync(["install", udid!, FIXTURE], 60_000);

    originPort = await freePortAsync();
    origin = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const requestBody = Buffer.concat(chunks);
        received.push({
          method: req.method ?? "",
          url: req.url ?? "",
          bodyBytes: requestBody.length,
          bodyStart: requestBody.subarray(0, 16).toString("utf-8"),
        });
        const body = JSON.stringify({ ok: true, path: req.url });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Serve-Sim-Fixture": "response",
        });
        res.end(body);
      });
    });
    await new Promise<void>((done) => origin!.listen(originPort, "127.0.0.1", done));
    await startServer();
    expect(await rebootCapture(true)).toBe("capturing");
    simctlSync([
      "spawn",
      udid!,
      "launchctl",
      "setenv",
      ORIGIN_ENV,
      `http://127.0.0.1:${originPort}/`,
    ]);

    simctlSync(["launch", udid!, APP]);
    await Bun.sleep(1_000);
  }, 180_000);

  afterAll(async () => {
    await stopServer();
    try {
      try {
        simctlSync(["terminate", udid!, APP]);
      } catch {}
      try {
        simctlSync(["uninstall", udid!, APP]);
      } catch {}
      try {
        simctlSync(["spawn", udid!, "launchctl", "unsetenv", ORIGIN_ENV]);
      } catch {}
      if (origin) {
        origin.closeAllConnections();
        await new Promise<void>((done) => origin!.close(() => done()));
      }
      expect(readInsert(udid!), stderr).toBe("");
      expect(simctlSync(["spawn", udid!, "launchctl", "getenv", "SIMNET_PROXY_PORT_FILE"])).toBe("");
    } finally {
      tempState.restore();
    }
  }, 180_000);

  async function startServer(defaultCapture = false): Promise<void> {
    serverPort = await freePortAsync();
    server = spawn(
      "node",
      [
        CLI,
        ...(defaultCapture ? ["--network-capture"] : []),
        "--network-capture-field",
        "header",
        "--network-capture-field",
        "query",
        "--network-capture-field",
        "request-body",
        "--network-capture-field",
        "response-body",
        "--quiet",
        "--port",
        String(serverPort),
        udid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    server.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await waitForAsync(() => existsSync(join(tempState.dir, `server-${udid!}.json`)));
  }

  async function stopServer(): Promise<void> {
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
  }

  async function expectCaptureOffAfterReconnect(): Promise<void> {
    const state = JSON.parse(readFileSync(join(tempState.dir, `server-${udid!}.json`), "utf-8")) as { token: string };
    const response = await fetch(`http://127.0.0.1:${serverPort}/grid/api/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}`, Origin: `http://127.0.0.1:${serverPort}`, "Content-Type": "application/json" },
      body: JSON.stringify({ udid }),
    });
    expect(response.ok).toBe(true);
    expect(readInsert(udid!)).not.toContain("libSimNetProxy");
    expect(simctlSync(["spawn", udid!, "launchctl", "getenv", "SIMNET_PROXY_PORT_FILE"])).toBe("");
  }

  async function captureAction(action: "capture.reboot" | "capture.enable", enabled?: boolean): Promise<string> {
    const state = JSON.parse(readFileSync(join(tempState.dir, `server-${udid!}.json`), "utf-8")) as { token: string };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/exec-ws`, {
        origin: `http://127.0.0.1:${serverPort}`,
      });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("Capture action timed out")); }, 150_000);
      ws.on("open", () => ws.send(JSON.stringify({ token: state.token })));
      ws.on("message", (data) => {
        const reply = JSON.parse(data.toString());
        if (reply.ready) ws.send(JSON.stringify({ id: 1, action, params: action === "capture.enable" ? { udid } : { udid, enabled } }));
        if (reply.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (reply.exitCode !== 0) reject(new Error(reply.stderr || reply.error));
        else resolve(JSON.parse(reply.stdout).attachment);
      });
      ws.on("error", (error) => { clearTimeout(timer); ws.terminate(); reject(error); });
    });
  }

  const rebootCapture = (enabled: boolean) => captureAction("capture.reboot", enabled);
  const enableCapture = () => captureAction("capture.enable");

  async function capturedEntries(): Promise<HarEntry[]> {
    const state = JSON.parse(readFileSync(join(tempState.dir, `server-${udid!}.json`), "utf-8")) as { token: string };
    const response = await fetch(`http://127.0.0.1:${serverPort}/network-capture.har?device=${udid!}`, {
      headers: { Authorization: `Bearer ${state.token}`, Origin: `http://127.0.0.1:${serverPort}` },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { log: { entries: HarEntry[] } }).log.entries;
  }

  function appResults(): string {
    const container = simctlSync(["get_app_container", udid!, APP, "data"]);
    const path = join(container, "Documents/network-requests.tsv");
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  }

  async function tapButton(id: string): Promise<void> {
    const state = JSON.parse(
      readFileSync(join(tempState.dir, `server-${udid!}.json`), "utf-8"),
    ) as { streamUrl: string; token?: string };
    const axUrl = state.streamUrl.replace(/\/stream\.mjpeg$/, "/ax");
    const find = (nodes: AxNode[]): AxNode | undefined => {
      for (const node of nodes) {
        if (node.AXUniqueId === id) return node;
        const child = find(node.children ?? []);
        if (child) return child;
      }
    };
    let roots: AxNode[] = [];
    await waitForAsync(async () => {
      const response = await fetch(axUrl, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
      });
      if (!response.ok) return false;
      roots = await response.json() as AxNode[];
      return !!roots[0] && !!find(roots);
    }, 15_000);
    const root = roots[0]!;
    const button = find(roots)!;
    const x = (button.frame.x + button.frame.width / 2 - root.frame.x) / root.frame.width;
    const y = (button.frame.y + button.frame.height / 2 - root.frame.y) / root.frame.height;
    execFileSync("node", [CLI, "tap", String(x), String(y), "-d", udid!], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  }

  for (const phase of ["pre-main", "app-delegate"]) {
    test(`captures a request initiated in ${phase}`, async () => {
      const path = `/api/startup/${phase}`;
      await waitForAsync(() => received.some((request) => request.url === path));
      expect(received.filter((request) => request.url === path)).toEqual([
        { method: "GET", url: path, bodyBytes: 0, bodyStart: "" },
      ]);
      let entries: HarEntry[] = [];
      await waitForAsync(async () => {
        entries = (await capturedEntries()).filter((entry) => entry.request.url.endsWith(path));
        return entries.length === 1 && entries[0]?.response.status === 200;
      });
      expect(entries[0]).toMatchObject({ request: { method: "GET" }, response: { status: 200 } });
      await waitForAsync(() => appResults().includes(`GET ${path} → 200`));
    }, 90_000);
  }

  test("the two buttons send a small GET and large POST that appear in capture", async () => {
    await tapButton("get-profile");
    await waitForAsync(() => received.some((request) => request.url === PROFILE_PATH));
    await tapButton("upload-three-megabytes");
    await waitForAsync(() => received.some((request) => request.url === UPLOAD_PATH));
    expect(received.filter((request) => [PROFILE_PATH, UPLOAD_PATH].includes(request.url))).toHaveLength(2);
    expect(received).toContainEqual({
      method: "GET",
      url: PROFILE_PATH,
      bodyBytes: 0,
      bodyStart: "",
    });
    expect(received).toContainEqual({
      method: "POST",
      url: UPLOAD_PATH,
      bodyBytes: UPLOAD_BYTES,
      bodyStart: "xxxxxxxxxxxxxxxx",
    });

    const state = JSON.parse(
      readFileSync(join(tempState.dir, `server-${udid!}.json`), "utf-8"),
    ) as { token: string };
    const headers = {
      Authorization: `Bearer ${state.token}`,
      Origin: `http://127.0.0.1:${serverPort}`,
    };
    let entries: HarEntry[] = [];
    await waitForAsync(async () => {
      entries = await capturedEntries();
      return [PROFILE_PATH, UPLOAD_PATH].every((path) =>
        entries.some((entry) => entry.request.url.endsWith(path) && entry.response.status === 200),
      );
    });

    const profile = entries.find((entry) => entry.request.url.endsWith(PROFILE_PATH));
    const upload = entries.find((entry) => entry.request.url.endsWith(UPLOAD_PATH));
    expect(profile).toMatchObject({ request: { method: "GET" }, response: { status: 200 } });
    // Each opted-in field arrives with its value: query, headers both ways, and the response body.
    expect(profile?.request.queryString).toContainEqual({ name: "source", value: "button" });
    expect(profile?.request.headers).toContainEqual({ name: "x-serve-sim-fixture", value: "profile" });
    expect(profile?.response.headers).toContainEqual({ name: "x-serve-sim-fixture", value: "response" });
    expect(JSON.parse(profile?.response.content.text ?? "null")).toEqual({ ok: true, path: PROFILE_PATH });
    expect(upload).toMatchObject({
      request: {
        method: "POST",
        bodySize: UPLOAD_BYTES,
      },
      response: { status: 200 },
    });
    expect(upload?.request.postData?.text).toHaveLength(CAPTURED_BODY_BYTES);
    const capturedBody = await fetch(
      `http://127.0.0.1:${serverPort}/network-capture/${upload!._captureId}?device=${udid!}`,
      { headers },
    ).then((response) => response.json()) as { requestBody: string; requestTruncated: boolean };
    expect(capturedBody.requestBody).toHaveLength(CAPTURED_BODY_BYTES);
    expect(capturedBody.requestTruncated).toBe(true);

    await waitForAsync(() => {
      const results = appResults();
      return results.includes("GET /api/profile → 200") && results.includes("POST /api/upload → 200");
    });
  }, 180_000);

  test("turns capture off and keeps it off after the preview reconnects", async () => {
    expect(await rebootCapture(false)).toBe("not-enabled");
    await expectCaptureOffAfterReconnect();
    expect(await enableCapture()).toBe("capturing");
    expect(readInsert(udid!)).toContain("libSimNetProxy");
  }, 360_000);

  test("enables capture for a running fixture without rebooting or relaunching it", async () => {
    expect(await rebootCapture(false)).toBe("not-enabled");
    simctlSync(["spawn", udid!, "launchctl", "setenv", ORIGIN_ENV, `http://127.0.0.1:${originPort}/`]);
    simctlSync(["launch", udid!, APP]);
    await Bun.sleep(1_000);
    const before = simctlSync(["spawn", udid!, "launchctl", "list"]);
    const fixtureEntry = before.split("\n").find((line) => line.includes(`UIKitApplication:${APP}`));
    expect(fixtureEntry).toBeDefined();
    expect(await enableCapture()).toBe("capturing");
    const after = simctlSync(["spawn", udid!, "launchctl", "list"]);
    expect(after.split("\n").find((line) => line.includes(`UIKitApplication:${APP}`))).toBe(fixtureEntry);
    const beforeRequests = received.filter((request) => request.url === TRIGGER_PROFILE_PATH).length;
    const beforeResults = appResults().split("GET /api/profile").length;
    const container = simctlSync(["get_app_container", udid!, APP, "data"]).trim();
    writeFileSync(join(container, "Documents/trigger-profile"), "1");
    await waitForAsync(() => appResults().split("GET /api/profile").length > beforeResults, 20_000);
    expect(appResults()).toContain(`GET /api/profile → 200`);
    await waitForAsync(() => received.filter((request) => request.url === TRIGGER_PROFILE_PATH).length > beforeRequests, 20_000);
    let entries: HarEntry[] = [];
    await waitForAsync(async () => {
      entries = await capturedEntries();
      return entries.some((entry) => entry.request.url.endsWith(TRIGGER_PROFILE_PATH) && entry.response.status === 200);
    }, 30_000);
  }, 180_000);

  test("the startup flag captures an already booted device", async () => {
    await stopServer();
    await startServer(true);
    await capturedEntries();
    expect(readInsert(udid!)).toContain("libSimNetProxy");
    expect(await rebootCapture(false)).toBe("not-enabled");
    await expectCaptureOffAfterReconnect();
  }, 360_000);
});
