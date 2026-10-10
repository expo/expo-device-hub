import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { simulatorBootEnv } from "./additional-dylibs";

const execFileAsync = promisify(execFile);

function commandOutput(args: string[], stdout: string): string {
  const insert = (args[0] === "getenv" && args[2] === "DYLD_INSERT_LIBRARIES")
    || (args[0] === "spawn" && args[2] === "launchctl" && args[3] === "getenv" && args[4] === "DYLD_INSERT_LIBRARIES");
  return insert ? stdout.replace(/\n$/, "") : stdout.trim();
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export interface SimctlOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

function optionsFor(value: number | SimctlOptions): Required<Pick<SimctlOptions, "timeout" | "maxBuffer">> &
  Pick<SimctlOptions, "env"> {
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
      ...(args[0] === "boot" || args[0] === "bootstatus" ? simulatorBootEnv(args[1]!) : process.env),
      ...options.env,
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw error;
    }
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

export function simctlSync(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): string {
  const options = optionsFor(timeoutOrOptions);
  const stdout = execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: { ...process.env, ...options.env },
  });
  return commandOutput(args, stdout);
}
