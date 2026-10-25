import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { simulatorBootEnv } from "./additional-dylibs";

const execFileAsync = promisify(execFile);

function commandOutput(args: string[], stdout: string): string {
  const insert =
    (args[0] === "getenv" && args[2] === "DYLD_INSERT_LIBRARIES") ||
    (args[0] === "spawn" &&
      args[2] === "launchctl" &&
      args[3] === "getenv" &&
      args[4] === "DYLD_INSERT_LIBRARIES");
  return insert ? stdout.replace(/\n$/, "") : stdout.trim();
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

// A stalled simulator and a failed command need different fixes, so say which one happened.
function nameTimeout(error: unknown, args: string[], timeout: number): boolean {
  const { killed, signal, code } = error as { killed?: boolean; signal?: string; code?: string };
  // Timeout 0 means no limit, so a SIGTERM then came from elsewhere.
  if (
    timeout <= 0 ||
    !(error instanceof Error) ||
    !((killed && signal === "SIGTERM") || code === "ETIMEDOUT")
  )
    return false;
  error.message = `xcrun simctl ${args.join(" ")} timed out after ${timeout / 1000} s`;
  return true;
}

export interface SimctlOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

function optionsFor(
  value: number | SimctlOptions,
): Required<Pick<SimctlOptions, "timeout" | "maxBuffer">> & Pick<SimctlOptions, "env"> {
  const options = typeof value === "number" ? { timeout: value } : value;
  return {
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(options.env ? { env: options.env } : {}),
  };
}

export async function simctlRaw(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): Promise<string> {
  const options = optionsFor(timeoutOrOptions);
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: {
      ...(args[0] === "boot" || args[0] === "bootstatus"
        ? simulatorBootEnv(args[1]!)
        : process.env),
      ...options.env,
    },
  }).catch((error: unknown) => {
    // stdout can hold clipboard text, which must not reach logs.
    if (error instanceof Error && "stdout" in error) delete (error as { stdout?: unknown }).stdout;
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      throw error;
    }
    if (nameTimeout(error, args, options.timeout)) throw error;
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw stderr ? new Error(`simctl ${args[0]}: ${stderr}`, { cause: error }) : error;
  });
  return stdout;
}

export async function simctl(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): Promise<string> {
  return commandOutput(args, await simctlRaw(args, timeoutOrOptions));
}

export function simctlSync(args: string[], timeoutOrOptions: number | SimctlOptions = {}): string {
  const options = optionsFor(timeoutOrOptions);
  try {
    const stdout = execFileSync("xcrun", ["simctl", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: { ...process.env, ...options.env },
    });
    return commandOutput(args, stdout);
  } catch (error) {
    nameTimeout(error, args, options.timeout);
    throw error;
  }
}
