import { execSimctl } from "./simctl";

/** Build the `simctl boot <udid>` args. */
export function buildBootArgs(udid: string): string[] {
  return ["boot", udid];
}

/**
 * Whether a `simctl boot` failure is the benign "device is already booted" case.
 *
 * `simctl boot` exits non-zero with "Unable to boot device in current state:
 * Booted" when the device is already running — which, for a boot request, is
 * success.
 */
export function isAlreadyBootedError(message: string): boolean {
  return /current state:\s*Booted/i.test(message);
}

/**
 * Run `xcrun simctl boot <udid>` and return whether the device ends up booted.
 *
 * Treats an already-booted device as success. Returns `false` on any other
 * failure. Never throws.
 */
export async function runSimctlBoot(udid: string): Promise<boolean> {
  try {
    await execSimctl(buildBootArgs(udid));
    return true;
  } catch (error) {
    if (isAlreadyBootedError(errorText(error))) return true;

    console.error("[apple-utils] Failed to run `xcrun simctl boot`:", error);
    return false;
  }
}

/** Collect the human-readable text from an exec error (its message and stderr). */
function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");

  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  return [message, stderr].filter((value) => typeof value === "string").join("\n");
}
