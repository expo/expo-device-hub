import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { CaptureStore } from "./store";
import { dirnameOf } from "../runtime";
import { DEFAULT_CAPTURE_FIELDS, type CaptureField } from "./fields";
import {
  DEFAULT_MAX_CONTROL_BODY_BYTES,
  MAX_CONTROL_BODY_BYTES_ENV,
  describeFailure,
  formatOversizedControlBodyWarning,
  maxControlBodyBytes,
  startMitmControl,
  type OversizedControlBodyInfo,
} from "./mitm-control";

export {
  DEFAULT_MAX_CONTROL_BODY_BYTES,
  MAX_CONTROL_BODY_BYTES_ENV,
  describeFailure,
  formatOversizedControlBodyWarning,
  maxControlBodyBytes,
};

// Bun inlines bare `__dirname` as the build machine's path; resolve from import.meta instead.
const __dirname = dirnameOf(import.meta.url);

const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 200;
const STARTUP_ATTEMPTS = 3;
const CONFDIR_PREFIX = "serve-sim-capture-";
export interface CaptureProxy {
  address: string;
  /** Port file for the injected library; lives in the session confdir. */
  portFile: string;
  caPem: () => Promise<string>;
  close: () => Promise<void>;
}

const MITMDUMP_CANDIDATES = [
  "/opt/homebrew/bin/mitmdump",
  "/usr/local/bin/mitmdump",
  "/Applications/mitmproxy.app/Contents/MacOS/mitmdump",
];

export function locateMitmdump(
  deps: {
    which?: (name: string) => string | null;
    candidates?: string[];
  } = {},
): string | null {
  const override = process.env.SERVE_SIM_MITMDUMP;
  if (override) return isRunnable(override) ? override : null;

  const onPath =
    deps.which ??
    ((name: string) => {
      const found = spawnSync("which", [name], { encoding: "utf8" });
      const path = found.status === 0 ? found.stdout.trim() : "";
      return path ? path : null;
    });
  const fromPath = onPath("mitmdump");
  if (fromPath) return fromPath;

  for (const candidate of deps.candidates ?? MITMDUMP_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function mitmdumpMissingMessage(override?: string): string {
  if (override) {
    return (
      `SERVE_SIM_MITMDUMP points at ${override}, which isn't a runnable file. Point it at the mitmdump ` +
      "executable, or unset it to use the copy on your PATH."
    );
  }
  return (
    "Network capture needs mitmproxy, which isn't installed. It terminates HTTP(S) so the " +
    "requests can be shown, and it isn't bundled because it is an 87MB signed binary that most projects " +
    "never need.\n\nInstall it with:  brew install mitmproxy\n\nOr download it from " +
    "https://mitmproxy.org/downloads and drag mitmproxy.app to /Applications. Then start capture again. " +
    "If it lives somewhere unusual, point SERVE_SIM_MITMDUMP at the mitmdump executable."
  );
}

function locateAddon(): string {
  const candidates = [
    join(__dirname, "mitm-addon", "servesim_capture.py"),
    join(__dirname, "..", "dist", "capture", "mitm-addon", "servesim_capture.py"),
    join(__dirname, "..", "src", "capture", "mitm-addon", "servesim_capture.py"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find servesim_capture.py, the addon that reports captured traffic. This build of serve-sim " +
      "is missing dist/capture/mitm-addon; reinstall from a recent release.",
  );
}

function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function sweepStaleConfdirs(deps: { list?: () => string[]; remove?: (dir: string) => void; psOutput?: () => string } = {}): number {
  const list =
    deps.list ??
    (() => {
      try {
        return readdirSync(tmpdir())
          .filter((name) => name.startsWith(CONFDIR_PREFIX))
          .map((name) => join(tmpdir(), name));
      } catch {
        return [];
      }
    });
  const psOutput =
    deps.psOutput ??
    (() => {
      const listed = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
      return listed.status === 0 && typeof listed.stdout === "string" ? listed.stdout : "";
    });
  const remove = deps.remove ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));

  const processes = psOutput();
  let swept = 0;
  for (const dir of list()) {
    if (processes.includes(basename(dir))) continue;
    try {
      remove(dir);
      swept++;
    } catch {
      // Another process may have removed it.
    }
  }
  return swept;
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local port for the capture proxy.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function parseMitmPids(psOutput: string, marker: string, selfPid: number): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.includes(marker)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid) && pid !== selfPid) pids.push(pid);
  }
  return pids;
}

export interface MitmProxyDeps {
  fields?: readonly CaptureField[];
  onUnexpectedExit?: (reason: string) => void;
  onOversizedControlBody?: (info: OversizedControlBodyInfo) => void;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const reapers = new Set<() => void>();
let listening = false;

function reapAll(): void {
  for (const reap of reapers) {
    try {
      reap();
    } catch {
      // Continue reaping the remaining proxies.
    }
  }
}

function onSignal(signal: NodeJS.Signals): void {
  reapAll();
  process.removeListener("exit", reapAll);
  for (const other of SIGNALS) process.removeListener(other, onSignal);
  if (process.listenerCount(signal) > 0) return;
  process.kill(process.pid, signal);
}

function addReaper(reap: () => void): void {
  reapers.add(reap);
  if (listening) return;
  listening = true;
  process.once("exit", reapAll);
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

function removeReaper(reap: () => void): void {
  reapers.delete(reap);
}

async function closeControlServer(
  control: Awaited<ReturnType<typeof startMitmControl>>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      control.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function startMitmProxyAttempt(
  store: CaptureStore,
  deps: MitmProxyDeps,
  mitmdump: string,
  addon: string,
  fields: readonly CaptureField[],
): Promise<CaptureProxy> {
  const proxyPort = await freePort();
  const confdir = mkdtempSync(join(tmpdir(), CONFDIR_PREFIX));
  const caFile = join(confdir, "mitmproxy-ca-cert.pem");
  const portFile = join(confdir, "proxy-port");
  const token = randomBytes(16).toString("hex");
  let control: Awaited<ReturnType<typeof startMitmControl>>;
  try {
    control = await startMitmControl({
      store,
      token,
      fields,
      onOversizedBody: deps.onOversizedControlBody,
    });
  } catch (error) {
    rmSync(confdir, { recursive: true, force: true });
    throw error;
  }

  let child: ChildProcess;
  try {
    writeFileSync(portFile, String(proxyPort));
    child = spawn(
      mitmdump,
      [
        "-q",
        "--listen-host",
        "127.0.0.1",
        "--listen-port",
        String(proxyPort),
        "--set",
        "anticomp=true",
        "--set",
        `confdir=${confdir}`,
        "-s",
        addon,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SERVE_SIM_CAPTURE_CONTROL_URL: `http://127.0.0.1:${control.port}`,
          SERVE_SIM_CAPTURE_CONTROL_TOKEN: token,
          SERVE_SIM_CAPTURE_FIELDS: fields.join(","),
          [MAX_CONTROL_BODY_BYTES_ENV]: String(maxControlBodyBytes()),
        },
      },
    );
  } catch (error) {
    await closeControlServer(control);
    rmSync(confdir, { recursive: true, force: true });
    throw error;
  }

  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let exited = false;
  let closing = false;
  let running = false;
  child.once("exit", (code) => {
    exited = true;
    if (closing || !running) return;
    deps.onUnexpectedExit?.(
      output.trim() || `The capture proxy stopped unexpectedly (exit ${code ?? "signal"}).`,
    );
  });
  let spawnError = "";
  child.once("error", (error: Error) => {
    exited = true;
    spawnError = error.message;
  });

  const marker = basename(confdir);

  const signalWorkers = (signal: "SIGTERM" | "SIGKILL"): void => {
    const listed = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
    if (listed.status !== 0 || typeof listed.stdout !== "string") return;
    for (const pid of parseMitmPids(listed.stdout, marker, process.pid)) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone between listing and signalling.
      }
    }
  };

  // Sync reap on exit/signal — `exit` alone misses SIGTERM/Ctrl-C.
  const reapOnExit = () => {
    signalWorkers("SIGKILL");
    rmSync(confdir, { recursive: true, force: true });
  };
  addReaper(reapOnExit);

  const close = async (): Promise<void> => {
    closing = true;
    try {
      if (!exited && child.pid != null) {
        const gone = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        child.kill("SIGTERM");
        const escalate = setTimeout(() => child.kill("SIGKILL"), 3000);
        await gone;
        clearTimeout(escalate);
      }
      signalWorkers("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      signalWorkers("SIGKILL");
      await closeControlServer(control);
      rmSync(confdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } finally {
      removeReaper(reapOnExit);
    }
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let announced = false;
  void control.ready.then(() => {
    announced = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      await close();
      throw new Error(
        `The capture proxy exited before it started listening.\n${
          spawnError || output.trim() || "No output from mitmproxy."
        }`,
      );
    }
    if (existsSync(caFile) && announced) {
      running = true;
      return {
        address: `127.0.0.1:${proxyPort}`,
        portFile,
        caPem: async () => readFileSync(caFile, "utf8"),
        close,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }

  const stalled = existsSync(caFile)
    ? "It started but its reporting addon never loaded, so nothing would have been captured."
    : `Check that no other process holds 127.0.0.1:${proxyPort}.`;
  await close();
  throw new Error(
    `The capture proxy did not start within ${STARTUP_TIMEOUT_MS / 1000}s. ${stalled}\n${output.trim()}`,
  );
}

function addressAlreadyInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|address already in use/i.test(message);
}

export async function startMitmProxy(
  store: CaptureStore,
  deps: MitmProxyDeps = {},
): Promise<CaptureProxy> {
  sweepStaleConfdirs();
  const mitmdump = locateMitmdump();
  if (!mitmdump) throw new Error(mitmdumpMissingMessage(process.env.SERVE_SIM_MITMDUMP));
  const addon = locateAddon();
  const fields = deps.fields ?? DEFAULT_CAPTURE_FIELDS;

  let lastError: unknown;
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
    try {
      return await startMitmProxyAttempt(store, deps, mitmdump, addon, fields);
    } catch (error) {
      lastError = error;
      if (!addressAlreadyInUse(error)) throw error;
    }
  }
  throw lastError;
}
