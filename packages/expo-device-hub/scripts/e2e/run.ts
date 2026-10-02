import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { buildDashboard } from "./build-dashboard";
import { openBrowser } from "./browser-driver";
import { startProxy } from "./proxy";

const udid = process.env.HUB_E2E_UDID;
if (!udid)
  throw new Error(
    "Set HUB_E2E_UDID to a dedicated, booted iOS Simulator. This suite never selects or boots a device automatically.",
  );
const booted = JSON.parse(
  execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf8" }),
);
if (
  !Object.values(booted.devices as Record<string, Array<{ udid: string }>>)
    .flat()
    .some((device) => device.udid === udid)
) {
  throw new Error(`HUB_E2E_UDID ${udid} is not booted`);
}
const repo = resolve(import.meta.dir, "../../../..");
const cli = join(repo, "packages/serve-sim/packages/serve-sim/dist/serve-sim.js");
const app = join(
  repo,
  "packages/serve-sim/packages/serve-sim/dist/capability-loader/ServeSimLaunchFixture.app",
);
const bundle = "dev.expo.serve-sim.launch-fixture";
await Promise.all([
  access(cli),
  access(app),
  access(join(repo, "packages/@expo/hub-client/dist/index.js")),
]);
const artifacts = await mkdtemp(join(tmpdir(), "hub-ui-client-e2e-"));
await mkdir(join(artifacts, "state"));
await buildDashboard(join(artifacts, "dashboard"));
execFileSync("xcrun", ["simctl", "install", udid, app]);
const container = execFileSync("xcrun", ["simctl", "get_app_container", udid, bundle, "data"], {
  encoding: "utf8",
}).trim();
const fixturePath = join(container, "Documents/launches.tsv");
await mkdir(join(container, "Documents"), { recursive: true });
await writeFile(fixturePath, "");
const backendLog = createWriteStream(join(artifacts, "backend.log"));
const reservation = createServer();
await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
const address = reservation.address();
if (!address || typeof address === "string") throw new Error("Port reservation failed");
const port = address.port;
await new Promise<void>((done, fail) =>
  reservation.close((error) => (error ? fail(error) : done())),
);
const backend = `http://127.0.0.1:${port}`;
let child: ChildProcess | undefined;
let proxy: ReturnType<typeof startProxy> | undefined;
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
let settleResult!: (result: unknown) => void;
const result = new Promise<unknown>((done) => {
  settleResult = done;
});
let stopped = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;

async function stopBackend() {
  const previous = child;
  child = undefined;
  if (!previous?.pid || previous.exitCode !== null || previous.signalCode !== null) return;
  const exited = new Promise<void>((done) => previous.once("exit", () => done()));
  previous.kill("SIGINT");
  await Promise.race([exited, pause(6_000)]);
  if (previous.exitCode === null && previous.signalCode === null) {
    previous.kill("SIGKILL");
    await exited;
  }
}
async function startBackend() {
  let error: Error | undefined;
  child = spawn(
    "node",
    [cli, udid!, "--port", String(port), "--transport", "webrtc", "--webrtc-codec", "h264"],
    {
      env: { ...process.env, SERVE_SIM_STATE_DIR: join(artifacts, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.on("error", (value) => {
    error = value;
  });
  child.stdout?.pipe(backendLog, { end: false });
  child.stderr?.pipe(backendLog, { end: false });
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("serve-sim exited; see backend.log");
    try {
      const response = await fetch(backend + "/api", { signal: AbortSignal.timeout(1_000) });
      const config = (await response.json()) as { device?: string; inputAdmission?: boolean };
      if (config.device === udid && config.inputAdmission === true) return;
    } catch {}
    await pause(200);
  }
  throw new Error("serve-sim startup timed out; see backend.log");
}
async function launch(keyboard: boolean) {
  try {
    execFileSync("xcrun", ["simctl", "terminate", udid!, bundle], { stdio: "ignore" });
  } catch {}
  execFileSync("xcrun", [
    "simctl",
    "launch",
    udid!,
    bundle,
    keyboard ? "--keyboard-test" : "--input-test",
  ]);
  await pause(1_000);
}
async function cleanup() {
  if (stopped) return;
  stopped = true;
  clearTimeout(watchdog);
  await browser?.close();
  await stopBackend();
  await proxy?.close();
  await new Promise<void>((done, fail) => {
    backendLog.once("error", fail);
    backendLog.end(done);
  });
}
const interrupted = () => {
  settleResult({ ok: false, error: "E2E interrupted" });
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  await startBackend();
  await launch(true);
  proxy = startProxy({
    backend,
    device: udid,
    assets: join(artifacts, "dashboard"),
    fixtureLog: () => readFile(fixturePath, "utf8").catch(() => ""),
    restart: async () => {
      await stopBackend();
      await startBackend();
    },
    launch,
    result: settleResult,
    start: () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => settleResult({ ok: false, error: "Browser suite timed out after 180 seconds" }),
        180_000,
      );
    },
  });
  const url = proxy.url + "/?run";
  console.log(JSON.stringify({ url, artifacts, udid }));
  if (!process.argv.includes("--interactive")) browser = await openBrowser(url, artifacts);
  if (!watchdog)
    watchdog = setTimeout(
      () => settleResult({ ok: false, error: "Browser did not start the suite" }),
      process.argv.includes("--interactive") ? 600_000 : 30_000,
    );
  const verification = (await result) as { ok: boolean; cases?: unknown; error?: string };
  await writeFile(join(artifacts, "verification.json"), JSON.stringify(verification, null, 2));
  await writeFile(join(artifacts, "wire.json"), JSON.stringify(proxy.snapshot(), null, 2));
  await writeFile(join(artifacts, "native-fixture.tsv"), await readFile(fixturePath, "utf8"));
  if (browser)
    await writeFile(
      join(artifacts, "dashboard.png"),
      Buffer.from(await browser.screenshot(), "base64"),
    );
  console.log(JSON.stringify(verification));
  if (!verification.ok) process.exitCode = 1;
} catch (error) {
  await writeFile(
    join(artifacts, "verification.json"),
    JSON.stringify({ ok: false, error: String(error) }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  console.log(`E2E evidence: ${artifacts}`);
}
// The CLI owns this process and has flushed evidence and stopped its children.
// Exit also drops browser-side keepalive/SSE clients held by Bun's HTTP runtime.
process.exit(process.exitCode ?? 0);
