import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { CaptureStore } from "./store";
import { assertNotOwnProxy, type CaptureUpstream } from "./upstream";
import { dirnameOf } from "../runtime";
import { withStateLockSync } from "../state-lock";
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

// mitmdump makes a new CA in every new confdir, and each one is trusted on the simulator, so trusted
// roots would pile up with every capture start. One CA is kept per user instead and copied into each
// confdir; mitmdump reuses a CA it finds there. Trusting the same certificate again adds nothing.
const CA_FILES = ["mitmproxy-ca.pem", "mitmproxy-ca-cert.pem"] as const;
const CA_CERT_FILE = "mitmproxy-ca-cert.pem";

/** Overrides where the capture CA is kept; the test scripts point it at a private temp folder. */
export const CAPTURE_CA_DIR_ENV = "SERVE_SIM_CAPTURE_CA_DIR";

/**
 * The private folder that holds this user's capture CA. It is durable, not under the state
 * directory: that lives in the system temp folder and moves with SERVE_SIM_STATE_DIR, and a lost CA
 * would mean one more trusted root on every simulator. Remove it to make a new CA.
 */
export function captureCaDir(): string {
  return process.env[CAPTURE_CA_DIR_ENV] || join(homedir(), "Library", "Application Support", "serve-sim", "capture-ca");
}

// Seeding and keeping run under one cross-process lock, so two first starts cannot leave one
// process's key beside the other's certificate.
function withCaLock<T>(operation: () => T): T {
  const dir = captureCaDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withStateLockSync(
    join(dir, ".lock"),
    10_000,
    () => new Error(`${dir}/.lock is still held by another serve-sim; retry once its capture has started.`),
    () => new Error("The capture CA lock is already held by this process."),
    operation,
  );
}

function seedCaInto(confdir: string): void {
  withCaLock(() => {
    const dir = captureCaDir();
    if (!CA_FILES.every((name) => existsSync(join(dir, name)))) return;
    for (const name of CA_FILES) copyFileSync(join(dir, name), join(confdir, name));
  });
}

/**
 * Keep the CA mitmdump made on the first start, for every later one. The first writer wins. Returns
 * false when this proxy lost that race: another first start saved a different CA meanwhile, and this
 * proxy should start again with the saved one so every session uses the same root.
 */
function keepCaFrom(confdir: string): boolean {
  try {
    return withCaLock(() => {
      const dir = captureCaDir();
      if (!CA_FILES.every((name) => existsSync(join(confdir, name)))) return true;
      if (CA_FILES.every((name) => existsSync(join(dir, name)))) {
        return readFileSync(join(dir, CA_CERT_FILE), "utf8") === readFileSync(join(confdir, CA_CERT_FILE), "utf8");
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const name of CA_FILES) {
        const temp = join(dir, `${name}.${process.pid}.tmp`);
        rmSync(temp, { force: true });
        writeFileSync(temp, readFileSync(join(confdir, name)), { mode: 0o600, flag: "wx" });
        renameSync(temp, join(dir, name));
      }
      return true;
    });
  } catch (error) {
    // This session keeps its own CA; the next start tries again.
    console.warn("Network capture: could not keep the capture CA for later sessions:", error instanceof Error ? error.message : error);
    return true;
  }
}

/** A first start that lost the race to save the CA; it starts again with the saved one. */
class CaRaceLostError extends Error {}
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
  // One line: the panel and the CLI both show it as the reason capture did not start.
  return "mitmproxy is not installed. Install it to use network capture: brew install mitmproxy";
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

/** A confdir exists before its mitmdump appears in `ps`, so a new one is never swept. */
const CONFDIR_MIN_AGE_MS = 60_000;

/**
 * The addon reports problems, such as records it could not deliver at shutdown, on stderr lines
 * that start with "[servesim-capture]". Pass those on; they hold counts, never traffic or tokens.
 */
export function forwardAddonDiagnostics(
  stream: NodeJS.ReadableStream,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  let pending = "";
  stream.on("data", (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    // A line longer than any diagnostic is not one; drop it rather than buffer without bound.
    if (pending.length > 4096) pending = "";
    for (const line of lines) {
      if (line.startsWith("[servesim-capture]")) warn(line.trimEnd());
    }
  });
}

export function sweepStaleConfdirs(
  deps: {
    list?: () => string[];
    remove?: (dir: string) => void;
    /** `null` when processes cannot be listed; nothing is swept then. */
    psOutput?: () => string | null;
    ageMs?: (dir: string) => number;
  } = {},
): number {
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
      return listed.status === 0 && typeof listed.stdout === "string" ? listed.stdout : null;
    });
  const remove = deps.remove ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const ageMs =
    deps.ageMs ??
    ((dir: string) => {
      try {
        return Date.now() - statSync(dir).mtimeMs;
      } catch {
        return 0;
      }
    });

  // Without a process list every confdir would look abandoned, including live sessions'.
  const processes = psOutput();
  if (processes === null) return 0;
  let swept = 0;
  for (const dir of list()) {
    if (processes.includes(basename(dir)) || ageMs(dir) < CONFDIR_MIN_AGE_MS) continue;
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
  upstream?: CaptureUpstream | null;
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
  // Another handler, such as the CLI's, shuts capture down gracefully so the addon can flush its
  // queue; killing mitmdump here would lose those records. The exit reaper stays as the fallback.
  if (process.listenerCount(signal) > 1) return;
  reapAll();
  process.removeListener("exit", reapAll);
  for (const other of SIGNALS) process.removeListener(other, onSignal);
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

/** Reaper registration, exposed so a test can check what a signal does. */
export const captureReapersForTest = { add: addReaper, remove: removeReaper };

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
  upstream: CaptureUpstream | null,
): Promise<CaptureProxy> {
  const proxyPort = await freePort();
  assertNotOwnProxy(upstream, proxyPort);
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
  let credentialPipeFailed = false;
  try {
    seedCaInto(confdir);
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
        ...(upstream ? ["--mode", `upstream:${upstream.url}`] : []),
        "--set",
        `confdir=${confdir}`,
        "-s",
        addon,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SERVE_SIM_CAPTURE_CONTROL_URL: `http://127.0.0.1:${control.port}`,
          SERVE_SIM_CAPTURE_CONTROL_TOKEN: token,
          SERVE_SIM_CAPTURE_FIELDS: fields.join(","),
          [MAX_CONTROL_BODY_BYTES_ENV]: String(maxControlBodyBytes()),
        },
      },
    );
    // The addon reads to EOF before announcing readiness; credentials never enter a file or argv.
    child.stdin!.once("error", () => {
      credentialPipeFailed = true;
      child.kill("SIGTERM");
    });
    child.stdin!.end(upstream?.auth ?? "");
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
  if (child.stderr) forwardAddonDiagnostics(child.stderr);

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
    if (exited || credentialPipeFailed) {
      await close();
      throw new Error(
        `The capture proxy exited before it started listening.\n${
          credentialPipeFailed ? "Could not deliver the capture proxy's startup credentials." :
          spawnError || output.trim() || "No output from mitmproxy."
        }`,
      );
    }
    if (existsSync(caFile) && announced) {
      if (!keepCaFrom(confdir)) {
        await close();
        throw new CaRaceLostError("Another capture saved the shared CA first; starting again with it.");
      }
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
  const upstream = deps.upstream ?? null;

  let lastError: unknown;
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
    try {
      return await startMitmProxyAttempt(store, deps, mitmdump, addon, fields, upstream);
    } catch (error) {
      lastError = error;
      if (!addressAlreadyInUse(error) && !(error instanceof CaRaceLostError)) throw error;
    }
  }
  throw lastError;
}
