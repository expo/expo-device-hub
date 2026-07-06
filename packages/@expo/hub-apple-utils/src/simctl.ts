import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run `xcrun simctl <args>` and resolve with its stdout/stderr.
 *
 * Throws (rejects) on a non-zero exit — callers that need to inspect the failure
 * (e.g. {@link runSimctlShutdown} detecting an already-shut-down device) use
 * this; most callers want {@link runSimctl}, which never throws.
 */
export function execSimctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("xcrun", ["simctl", ...args]);
}

/**
 * Run `xcrun simctl <args>` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runSimctl(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execSimctl(args);
    return stdout;
  } catch (error) {
    console.error(`[apple-utils] Failed to run \`xcrun simctl ${args.join(" ")}\`:`, error);
    return null;
  }
}

/** Collect the human-readable text from an exec error (its message and stderr). */
export function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");

  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  return [message, stderr].filter((value) => typeof value === "string").join("\n");
}
