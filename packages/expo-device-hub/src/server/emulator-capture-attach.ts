import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  emulatorCaptureLogPath,
  ensurePrivateDirectory,
  type EmulatorCapture,
} from "./emulator-capture";

/** The emulator to attach to: its serial names the socket, its QEMU process loads the agent. */
export type EmulatorCaptureAttachRequest = { serial: string; processId: number };

export type AttachRunResult = {
  /** The debugger's exit code, or null when it did not exit by itself. */
  code: number | null;
  /** Its standard output and error, in order. */
  output: string;
  /** Set when the debugger could not start. */
  spawnError?: NodeJS.ErrnoException;
  timedOut?: boolean;
};

export type EmulatorCaptureAttachDependencies = {
  run?: (command: string, args: readonly string[], timeoutMs: number) => Promise<AttachRunResult>;
  /** Reads a small system file, such as one in /proc; null when it cannot be read. */
  readText?: (path: string) => string | null;
  uid?: () => number | undefined;
  socketReady?: (socket: string) => boolean;
  wait?: (ms: number) => Promise<void>;
  logSize?: (path: string) => number;
  readLogFrom?: (path: string, offset: number) => string;
  ensureDirectory?: (path: string) => Promise<void>;
};

const SOCKET_VARIABLE = "EXPO_EMULATOR_CAPTURE_SOCKET";
const LOG_VARIABLE = "EXPO_EMULATOR_CAPTURE_LOG";
const RTLD_NOW = 2;
// macOS can wait for the user to type a password in its dialog.
const DEBUGGER_TIMEOUT_MS = { darwin: 180_000, linux: 90_000 } as const;
const SOCKET_TIMEOUT_MS = 15_000;
/** Asynchronous signals that the debugger passes to QEMU without stopping, during the calls. */
const DARWIN_PASSED_SIGNALS = [
  "SIGUSR1",
  "SIGUSR2",
  "SIGALRM",
  "SIGVTALRM",
  "SIGPROF",
  "SIGCHLD",
  "SIGPIPE",
  "SIGWINCH",
  "SIGIO",
];
/** Linux also has real-time signals. */
const PASSED_SIGNALS = [
  "SIGUSR1",
  "SIGUSR2",
  "SIGALRM",
  "SIGVTALRM",
  "SIGPROF",
  "SIGCHLD",
  "SIGPIPE",
  "SIGWINCH",
  "SIGIO",
  ...Array.from({ length: 13 }, (_, index) => `SIG${32 + index}`),
];
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 64 * 1024;

/** A C string literal for a debugger expression. */
function cString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// @ref LLP 0019#how-the-agent-loads — setenv, then dlopen: the agent reads its socket at load
/**
 * The debugger command that loads the agent into a running QEMU process: it sets the socket and
 * log variables in that process, loads the library, reads `dlerror()`, and detaches.
 */
export function emulatorCaptureAttachCommand(
  platform: EmulatorCapture["platform"],
  options: { processId: number; library: string; socket: string; log: string },
): { command: string; args: string[] } {
  const calls = [
    `(int) setenv(${cString(SOCKET_VARIABLE)}, ${cString(options.socket)}, 1)`,
    `(int) setenv(${cString(LOG_VARIABLE)}, ${cString(options.log)}, 1)`,
    `(void *) dlopen(${cString(options.library)}, ${RTLD_NOW})`,
    `(char *) dlerror()`,
  ];
  if (platform === "darwin") {
    return {
      command: "lldb",
      args: [
        "--batch",
        "--no-lldbinit",
        "--attach-pid",
        String(options.processId),
        // As for gdb: QEMU's own signals pass through without stopping the calls.
        "--one-line",
        `process handle --stop false --pass true --notify false ${DARWIN_PASSED_SIGNALS.join(" ")}`,
        ...calls.flatMap((call) => ["--one-line", `expression -- ${call}`]),
        "--one-line",
        "process detach",
      ],
    };
  }
  return {
    command: "gdb",
    args: [
      "--batch",
      "--nx",
      // Loads the symbols of libc only: the emulator maps many large libraries.
      "-iex",
      "set auto-solib-add off",
      "-iex",
      "set debuginfod enabled off",
      // QEMU signals its own threads, for example to kick a vCPU. Passed through, such a signal
      // does not stop gdb, so it does not unwind a call; a fault still stops and unwinds it.
      "-iex",
      `handle ${PASSED_SIGNALS.join(" ")} nostop noprint pass`,
      "-p",
      String(options.processId),
      "-ex",
      "sharedlibrary libc\\.so",
      // A signal during a call unwinds it instead of leaving the process stopped in it.
      "-ex",
      "set unwindonsignal on",
      ...calls.flatMap((call) => ["-ex", `call ${call}`]),
      "-ex",
      "detach",
    ],
  };
}

/**
 * What `dlopen` returned in the debugger's output: the library handle, or the `dlerror()` text
 * when it returned null. Null when the output has no result, for example after a failed attach.
 */
export function parseAttachOutput(
  platform: EmulatorCapture["platform"],
  output: string,
): { loaded: true } | { loaded: false; error: string | null } | null {
  const handle =
    platform === "darwin"
      ? /^\(void \*\) \$\d+ = (0x[0-9a-f]+)/m.exec(output)?.[1]
      : /^\$\d+ = \(void \*\) (0x[0-9a-f]+)/m.exec(output)?.[1];
  if (handle === undefined) return null;
  if (BigInt(handle) !== 0n) return { loaded: true };
  const error =
    platform === "darwin"
      ? /^\(char \*\) \$\d+ = 0x[0-9a-f]+ "(.*)"$/m.exec(output)?.[1]
      : /^\$\d+ = 0x[0-9a-f]+ "(.*)"$/m.exec(output)?.[1];
  return { loaded: false, error: error ?? null };
}

/**
 * Why Linux would refuse the attach, from `kernel.yama.ptrace_scope`, or null. With scope 1, a
 * process may trace only its own descendants, and the debugger is not an ancestor of QEMU.
 */
export function linuxPtraceProblem(scope: string | null, uid: number | undefined): string | null {
  const value = scope?.trim();
  if (!value || value === "0" || uid === 0) return null;
  if (value === "1") {
    return "Linux lets a process attach only to its own child processes (kernel.yama.ptrace_scope is 1). Allow attaching with: sudo sysctl kernel.yama.ptrace_scope=0, or start the emulator from the Hub.";
  }
  if (value === "2") {
    return "Only root can attach to another process on this host (kernel.yama.ptrace_scope is 2). Start the emulator from the Hub.";
  }
  return `This host does not let processes attach to each other (kernel.yama.ptrace_scope is ${value}). Start the emulator from the Hub.`;
}

/** Why the debugger could not load the agent, for the user. */
function debuggerFailure(
  platform: EmulatorCapture["platform"],
  result: AttachRunResult,
  timeoutMs: number,
): string {
  if (result.spawnError?.code === "ENOENT") {
    return platform === "darwin"
      ? "lldb is missing, so the Hub cannot attach the capture agent. Install the Xcode Command Line Tools with: xcode-select --install"
      : "gdb is missing, so the Hub cannot attach the capture agent. Install it with: sudo apt install gdb";
  }
  if (result.spawnError) {
    return `The debugger did not start: ${result.spawnError.message}`;
  }
  if (result.timedOut) {
    return `The attach did not finish in ${Math.round(timeoutMs / 1000)} s.`;
  }
  const output = result.output;
  if (platform === "darwin") {
    const attachError = /error: attach failed: ([^\n]+)/.exec(output)?.[1]?.trim();
    if (attachError) {
      return /not allowed|denied|permission/i.test(attachError)
        ? "macOS did not let the Hub attach the capture agent to this emulator. Enter your password when macOS asks on this Mac, or allow debugging without a password with: sudo DevToolsSecurity -enable"
        : `lldb could not attach to the emulator: ${attachError}`;
    }
  } else if (/ptrace: Operation not permitted|Could not attach to process/.test(output)) {
    return "Linux did not let gdb attach to the emulator. Allow attaching with: sudo sysctl kernel.yama.ptrace_scope=0, or start the emulator from the Hub.";
  } else if (/signaled while in a function called from GDB/.test(output)) {
    return "A signal stopped the emulator during the attach, so gdb undid it. Select Emulator capture to try again.";
  }
  const lastLine = output.trim().split("\n").at(-1)?.trim();
  return `The debugger did not load the capture agent${lastLine ? `: ${lastLine}` : "."}`;
}

/** Why the agent did not open its socket, from what it logged since the attach began. */
function agentFailure(log: string, logged: string): string {
  const disabled = logged
    .split("\n")
    .map((line) => /capture disabled: (.+)$/.exec(line)?.[1]?.trim())
    .filter(Boolean)
    .at(-1);
  if (disabled) return `The capture agent turned itself off in this emulator: ${disabled}.`;
  return logged.trim()
    ? `The capture agent did not open its socket. Its log is ${log}.`
    : "The capture agent did not start in this emulator. It may be loaded already from an earlier start; start the emulator again from the Hub.";
}

function runDebugger(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<AttachRunResult> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: AttachRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish({ code: null, output, spawnError: error }),
    );
    child.once("close", (code) => finish({ code, output }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, output, timedOut: true });
    }, timeoutMs);
  });
}

function readSmallFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Whether this user's agent serves the socket: a socket that this user owns, not a link. */
function ownSocketExists(socket: string): boolean {
  try {
    const info = lstatSync(socket);
    const uid = process.getuid?.();
    return info.isSocket() && (uid === undefined || info.uid === uid);
  } catch {
    return false;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readFrom(path: string, offset: number): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const start = Math.max(offset, size - MAX_LOG_BYTES);
    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * Loads the capture agent into an emulator that runs without it: lldb on macOS, gdb on Linux.
 * Resolves when the agent serves the emulator's socket, and rejects with a reason for the user.
 */
export async function attachEmulatorCapture(
  capture: EmulatorCapture,
  { serial, processId }: EmulatorCaptureAttachRequest,
  dependencies: EmulatorCaptureAttachDependencies = {},
): Promise<void> {
  const run = dependencies.run ?? runDebugger;
  const readText = dependencies.readText ?? readSmallFile;
  const uid = dependencies.uid ?? (() => process.getuid?.());
  const socketReady = dependencies.socketReady ?? ownSocketExists;
  const wait = dependencies.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const logSize = dependencies.logSize ?? fileSize;
  const readLogFrom = dependencies.readLogFrom ?? readFrom;
  const ensureDirectory = dependencies.ensureDirectory ?? ensurePrivateDirectory;

  // The package install, and on Linux the x264 check, as for a boot.
  const library = await capture.library();
  await ensureDirectory(capture.socketDirectory);
  const socket = join(capture.socketDirectory, `${serial}.sock`);
  const log = emulatorCaptureLogPath(capture.socketDirectory, serial);
  if (capture.platform === "linux") {
    const ptrace = linuxPtraceProblem(readText("/proc/sys/kernel/yama/ptrace_scope"), uid());
    if (ptrace) throw new Error(ptrace);
    // A second dlopen of a loaded library does not run it again.
    if (readText(`/proc/${processId}/maps`)?.includes("libexpo_emulator_capture")) {
      throw new Error(
        `${agentFailure(log, readLogFrom(log, 0))} The agent is loaded in this emulator already.`,
      );
    }
  }
  const logStart = logSize(log);
  const { command, args } = emulatorCaptureAttachCommand(capture.platform, {
    processId,
    library,
    socket,
    log,
  });
  console.log(
    `[emulator capture] ${serial}: attaching the agent to process ${processId} with ${command}`,
  );
  const timeoutMs = DEBUGGER_TIMEOUT_MS[capture.platform];
  const result = await run(command, args, timeoutMs);
  const parsed =
    result.spawnError || result.timedOut
      ? null
      : parseAttachOutput(capture.platform, result.output);
  if (parsed === null) throw new Error(debuggerFailure(capture.platform, result, timeoutMs));
  if (!parsed.loaded) {
    throw new Error(
      `The emulator did not load the capture agent${parsed.error ? `: ${parsed.error}` : "."}`,
    );
  }
  for (let waited = 0; waited < SOCKET_TIMEOUT_MS; waited += 100) {
    if (socketReady(socket)) return;
    await wait(100);
  }
  throw new Error(agentFailure(log, readLogFrom(log, logStart)));
}

/** Shown with the capture option for an emulator that runs without the agent. */
export function emulatorCaptureAttachNote(platform: EmulatorCapture["platform"]): string {
  return platform === "darwin"
    ? "The agent is not in this emulator yet. The Hub attaches it when this source starts; macOS can ask for your password on this Mac."
    : "The agent is not in this emulator yet. The Hub attaches it with gdb when this source starts.";
}
