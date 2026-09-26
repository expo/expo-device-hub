import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  }).catch((error: unknown) => {
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
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
}

export function simctlSync(
  args: string[],
  timeoutOrOptions: number | SimctlOptions = {},
): string {
  return simctlSyncRaw(args, timeoutOrOptions).trim();
}
