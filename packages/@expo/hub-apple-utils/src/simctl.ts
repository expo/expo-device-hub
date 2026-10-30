import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";

const execFileAsync = promisify(execFile);

/** Matches serve-sim's simctl default. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run `xcrun simctl <args>` and resolve with its stdout/stderr.
 *
 * Returns stdout/stderr on success and the command failure in `error`. Callers
 * such as boot/shutdown can supply an `ignoreError` predicate for benign
 * already-transitioned-device failures.
 *
 * The child is sent SIGTERM after `timeoutMs` (default 30 s). Without it, every
 * call hangs while CoreSimulatorService is unresponsive. A timeout is reported as
 * its own error, and `ignoreError` never hides it.
 */
interface ExecSimctlOptions {
  errorMessage?: string;
  ignoreError?: (error: unknown) => boolean;
  timeoutMs?: number;
}

export async function execSimctl(
  args: string[],
  options: ExecSimctlOptions = {},
): Promise<AppleUtilsResult<{ stdout: string; stderr: string } | null>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return result(await execFileAsync("xcrun", ["simctl", ...args], { timeout: timeoutMs }));
  } catch (error) {
    if (isTimeout(error)) {
      return result(
        null,
        reportError(
          `[apple-utils] \`xcrun simctl ${args.join(" ")}\` did not respond within ${timeoutMs / 1000} s; CoreSimulatorService may need restarting`,
          error,
        ),
      );
    }
    if (options.ignoreError?.(error)) return result(null);

    return result(
      null,
      reportError(
        options.errorMessage ?? `[apple-utils] Failed to run \`xcrun simctl ${args.join(" ")}\`:`,
        error,
      ),
    );
  }
}

/**
 * Run `xcrun simctl <args>` and return its stdout as `value`, or `null` plus an
 * `error` on failure. Never throws.
 */
export async function runSimctl(args: string[]): Promise<AppleUtilsResult<string | null>> {
  const executed = await execSimctl(args);
  return result(executed.value?.stdout ?? null, executed.error);
}

/**
 * Whether `execFile` killed the child because its `timeout` elapsed.
 *
 * Node sets `killed` only when it sent the signal itself, and here only the
 * timeout does. `signal` is not checked: a child that catches SIGTERM and exits
 * with a code reports `signal: null`.
 */
function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  return (error as { killed?: unknown }).killed === true;
}

/** Collect the human-readable text from an exec error (its message and stderr). */
export function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");

  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  return [message, stderr].filter((value) => typeof value === "string").join("\n");
}
