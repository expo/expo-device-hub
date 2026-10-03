import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export interface SimctlOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
}

function optionsFor(value: number | SimctlOptions): Required<Pick<SimctlOptions, "timeout" | "maxBuffer">> &
  Pick<SimctlOptions, "env" | "signal"> {
  const options = typeof value === "number" ? { timeout: value } : value;
  return {
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

export async function simctlRaw(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): Promise<string> {
  const options = optionsFor(timeoutOrOptions);
  options.signal?.throwIfAborted();
  const execution = execFileAsync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: { ...process.env, ...options.env },
    signal: options.signal,
    killSignal: options.signal ? "SIGKILL" : "SIGTERM",
  });
  // Aborting execFile rejects before its child exits; shutdown must wait for the writer to stop.
  const closed = options.signal ? new Promise<void>((resolve) => execution.child.once("close", () => resolve())) : undefined;
  const { stdout } = await execution.catch(async (error: unknown) => {
    if (closed) await closed;
    if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw error;
    }
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw stderr ? new Error(stderr) : error;
  });
  return stdout;
}

export async function simctl(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): Promise<string> {
  return (await simctlRaw(args, timeoutOrOptions)).trim();
}

export function simctlSyncRaw(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): string {
  const options = optionsFor(timeoutOrOptions);
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: { ...process.env, ...options.env },
  });
}

export function simctlSync(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): string {
  return simctlSyncRaw(args, timeoutOrOptions).trim();
}
