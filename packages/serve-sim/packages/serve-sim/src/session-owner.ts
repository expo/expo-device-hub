import { randomBytes, timingSafeEqual } from "crypto";
import { execFileSync } from "child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createConnection, createServer, type Socket } from "net";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { sessionConfigurationSchema, type SessionConfiguration } from "./session-configuration";
import {
  previewStartupPayload,
  stateDir,
  stateFileForDevice,
  type ServeSimDeviceState,
} from "./state";
import { isLoopbackHost } from "./middleware-utils";

const MAX_MESSAGE_BYTES = 64 * 1024;
// Kept outside HTTP host-action roots, even when TMPDIR or SERVE_SIM_STATE_DIR is overridden.
// A short canonical path also stays below Darwin's Unix socket path limit.
const OWNER_ROOT = realpathSync("/tmp");

export interface SessionIdentity {
  version: string;
  pid: number;
  device: string;
  bootSession: string;
  host: string;
  port: number;
  stateDirectory: string;
  temporaryDirectory: string;
  environment: Record<string, string>;
}

/** Process-bound settings cannot be changed by adopting an already running process. */
export function sessionEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(
        ([name]) =>
          name !== "SERVE_SIM_STATE_DIR" &&
          name !== "SERVE_SIM_VERSION" &&
          (name === "DEVELOPER_DIR" ||
            name.startsWith("SERVE_SIM_") ||
            name.startsWith("SIMCTL_CHILD_")),
      )
      .sort(([left], [right]) => left.localeCompare(right)) as [string, string][],
  );
}

export function bootSession(): string {
  const value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  if (!value) throw new Error("Could not identify the current macOS boot");
  return value;
}

export function sessionOwnerFile(device: string): string {
  return join(stateDir(), `owner-${device}.json`);
}

function readOwnerFile(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192
    ) {
      throw new Error("Invalid local session owner file");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function identityMatches(identity: unknown, expected: SessionIdentity): boolean {
  if (!identity || typeof identity !== "object") return false;
  const actual = identity as Record<string, unknown>;
  return Object.entries(expected).every(([name, value]) =>
    name === "environment"
      ? JSON.stringify(actual[name]) === JSON.stringify(value)
      : actual[name] === value,
  );
}

/** Local OS-user authority, independent of the shareable preview bearer token. */
// @ref LLP 0003#prepared-process-handoff — no network transport can claim process ownership.
export async function startSessionOwner(
  device: string,
  identity: () => SessionIdentity,
  configure: (configuration: SessionConfiguration) => Promise<void>,
): Promise<{ close(): void }> {
  const directory = mkdtempSync(join(OWNER_ROOT, "serve-sim-owner-"));
  // mkdtemp uses 0700; do not use a directory under the configurable upload/state roots.
  const socketPath = join(directory, "control.sock");
  const secret = randomBytes(32).toString("hex");
  const metadata = JSON.stringify({ pid: process.pid, directory });
  const file = sessionOwnerFile(device);
  const sockets = new Set<Socket>();
  let claimed = false;
  let closed = false;
  const removeAuthority = () => {
    try {
      if (readOwnerFile(file) === metadata) unlinkSync(file);
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    removeAuthority();
    process.off("exit", close);
  };
  const server = createServer((socket) => {
    if (claimed || closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let message = Buffer.alloc(0);
    const respond = (value: object) => {
      if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n");
    };
    const onData = async (chunk: Buffer) => {
      message = Buffer.concat([message, chunk]);
      if (message.length > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      if (!message.includes(10)) return;
      socket.off("data", onData);
      try {
        const request = JSON.parse(message.toString("utf8"));
        if (
          typeof request.secret !== "string" ||
          request.secret.length !== secret.length ||
          !timingSafeEqual(Buffer.from(request.secret), Buffer.from(secret))
        ) {
          respond({ ok: false, error: "local_owner_required" });
          return;
        }
        if (request.method === "identity") {
          respond({ ok: true, identity: identity() });
          return;
        }
        if (request.method !== "configure" || !identityMatches(request.identity, identity())) {
          respond({ ok: false, error: "incompatible_session" });
          return;
        }
        if (claimed || closed) {
          respond({ ok: false, error: "session_already_configured" });
          return;
        }
        // Reserve before parsing or awaiting native setup. Failure requires a new process.
        claimed = true;
        server.close();
        for (const other of sockets) if (other !== socket) other.destroy();
        removeAuthority();
        socket.setTimeout(120_000, () => socket.destroy());
        const configuration = sessionConfigurationSchema.parse(request.configuration);
        await configure(configuration);
        if (!closed) respond({ ok: true, version: identity().version });
      } catch {
        respond({ ok: false, error: "session_configuration_failed" });
      }
    };
    socket.on("data", onData);
  });
  server.maxConnections = 8;
  try {
    writeFileSync(join(directory, "authority"), secret, { mode: 0o600, flag: "wx" });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Unix sockets otherwise inherit the process umask (often 022).
    const { chmodSync } = await import("fs");
    chmodSync(socketPath, 0o600);
    server.on("error", close);
    mkdirSync(stateDir(), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, metadata, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    process.once("exit", close);
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}

function localOwnerRequest(
  socketPath: string,
  secret: string,
  request: object,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let message = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Local session owner timed out")), 120_000);
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Local session owner closed before confirmation")));
    socket.once("connect", () => socket.write(JSON.stringify({ ...request, secret }) + "\n"));
    socket.on("data", (chunk: Buffer) => {
      message = Buffer.concat([message, chunk]);
      if (message.length > MAX_MESSAGE_BYTES) {
        finish(new Error("Invalid local owner response"));
        return;
      }
      if (!message.includes(10)) return;
      try {
        const result = JSON.parse(message.toString("utf8"));
        if (result.ok !== true)
          throw new Error(`Prepared serve-sim rejected adoption: ${result.error}`);
        finish(undefined, result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** CLI-only handoff. Nothing is sent to the HTTP server or execution WebSocket. */
export async function adoptSession(
  device: string,
  version: string,
  host: string,
  port: number | undefined,
  configuration: SessionConfiguration,
): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device)) {
    throw new Error("--adopt requires exactly one Simulator UDID");
  }
  device = device.toUpperCase();
  const state = JSON.parse(readFileSync(stateFileForDevice(device), "utf8")) as ServeSimDeviceState;
  const url = new URL(state.url);
  if (
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0 ||
    state.device !== device ||
    !state.token ||
    !isLoopbackHost(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    Number(url.port || 80) !== state.port ||
    (port !== undefined && port !== state.port)
  ) {
    throw new Error("Prepared serve-sim state does not match the requested device or port");
  }
  process.kill(state.pid, 0);
  const owner = JSON.parse(readOwnerFile(sessionOwnerFile(device)));
  if (
    owner.pid !== state.pid ||
    typeof owner.directory !== "string" ||
    dirname(owner.directory) !== OWNER_ROOT ||
    !/^serve-sim-owner-[A-Za-z0-9]{6}$/.test(owner.directory.slice(OWNER_ROOT.length + 1))
  ) {
    throw new Error("Prepared serve-sim has no compatible local owner");
  }
  const directory = lstatSync(owner.directory);
  const socketPath = join(owner.directory, "control.sock");
  const socket = lstatSync(socketPath);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid!() ||
    (directory.mode & 0o777) !== 0o700 ||
    !socket.isSocket() ||
    socket.uid !== process.getuid!() ||
    (socket.mode & 0o777) !== 0o600
  ) {
    throw new Error("Prepared serve-sim local owner permissions are invalid");
  }
  const secret = readOwnerFile(join(owner.directory, "authority"));
  const expected: SessionIdentity = {
    version,
    pid: state.pid,
    device,
    bootSession: bootSession(),
    host,
    port: state.port,
    stateDirectory: resolve(stateDir()),
    temporaryDirectory: resolve(tmpdir()),
    environment: sessionEnvironment(),
  };
  const identity = await localOwnerRequest(socketPath, secret, { method: "identity" });
  if (!identityMatches(identity.identity, expected)) {
    throw new Error(
      "Prepared serve-sim identity or startup environment is incompatible; use a cold start",
    );
  }
  const result = await localOwnerRequest(socketPath, secret, {
    method: "configure",
    identity: expected,
    configuration: sessionConfigurationSchema.parse(configuration),
  });
  if (result.version !== version) throw new Error("Prepared serve-sim did not confirm adoption");
  return previewStartupPayload([state], state.token);
}
