import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";

const execFileAsync = promisify(execFile);

/**
 * Run `xcrun simctl <args>` and resolve with its stdout/stderr.
 *
 * Returns stdout/stderr on success and the command failure in `error`. Callers
 * such as boot/shutdown can supply an `ignoreError` predicate for benign
 * already-transitioned-device failures.
 */
interface ExecSimctlOptions {
  errorMessage?: string;
  ignoreError?: (error: unknown) => boolean;
}

export async function execSimctl(
  args: string[],
  options: ExecSimctlOptions = {},
): Promise<AppleUtilsResult<{ stdout: string; stderr: string } | null>> {
  try {
    return result(await execFileAsync("xcrun", ["simctl", ...args]));
  } catch (error) {
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

/** Collect the human-readable text from an exec error (its message and stderr). */
export function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");

  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  return [message, stderr].filter((value) => typeof value === "string").join("\n");
}
