import {
  type HostActionParams,
  type HostActionResult,
  isTransportFailure,
  lastStderrLine,
  type RunHostAction,
} from "./exec-ws";
import {
  type KeychainKeyResult,
  type KeychainOptions,
  type KeychainWriteOptions,
  type KeychainWriteResult,
} from "./types";

/**
 * Keychain values of iOS simulator apps over serve-sim's `keychain.*` host actions, in the layout
 * of a library the app uses. serve-sim writes from inside the app, so the values land in the app's
 * own access group. Values travel as action parameters and never come back.
 */

// serve-sim bounds these in-process actions only by its own waits: up to 30 s to find the app's
// container, 15 s to see whether it runs, 60 s for another request to the same app
// (`requestKeychain` in its sim-keychain.ts), 3 s for the answer, and 5 s of grace. A relaunch
// adds up to 90 s for the device lock, 15 s to stop the app, 30 s to start it, and 20 s for its
// answer (its launch-manager.ts). The waits cover those, so a slow write reports its real result.
const ACTION_TIMEOUT_MS = 120_000;
const RELAUNCH_TIMEOUT_MS = 300_000;
const LOST = "Lost the connection to serve-sim before it answered.";

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseKeychainWrite(stdout: string): KeychainWriteResult | null {
  const payload = parseJson(stdout);
  if (payload?.applied === false) return { applied: false };
  if (payload?.applied !== true || !Array.isArray(payload.keys)) return null;
  const keys: KeychainKeyResult[] = [];
  for (const entry of payload.keys as unknown[]) {
    const row = entry as Partial<KeychainKeyResult> | null;
    if (
      typeof row?.key !== "string" ||
      typeof row.status !== "number" ||
      typeof row.ok !== "boolean" ||
      typeof row.message !== "string"
    ) {
      return null;
    }
    keys.push({ key: row.key, status: row.status, ok: row.ok, message: row.message });
  }
  return { applied: true, keys };
}

// The server keeps running an action whose reply was lost, so a write may still apply.
async function request(
  run: RunHostAction,
  action: string,
  params: HostActionParams,
  timeoutMs: number,
  lost: string,
): Promise<HostActionResult> {
  try {
    return await run(action, params, { timeoutMs });
  } catch (error) {
    if (error instanceof Error && isTransportFailure(error.message)) throw new Error(lost);
    throw error;
  }
}

function target(udid: string, appId: string, options?: KeychainOptions): HostActionParams {
  return { udid, bundleId: appId, format: options?.format, service: options?.service };
}

export async function listIosKeychainKeys(
  run: RunHostAction,
  udid: string,
  appId: string,
  options?: KeychainOptions,
): Promise<string[]> {
  const result = await request(
    run,
    "keychain.list",
    target(udid, appId, options),
    ACTION_TIMEOUT_MS,
    `${LOST} Retry.`,
  );
  if (result.exitCode !== 0) {
    throw new Error(lastStderrLine(result, "Could not list the app's keychain keys."));
  }
  const keys = parseJson(result.stdout)?.keys;
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new Error("serve-sim sent an unreadable keychain list.");
  }
  return keys;
}

// A key that failed fails the action, but its results are still in stdout.
async function write(
  run: RunHostAction,
  action: "keychain.set" | "keychain.delete",
  params: HostActionParams,
  options: KeychainWriteOptions | undefined,
  fallback: string,
): Promise<KeychainWriteResult> {
  const result = await request(
    run,
    action,
    { ...params, relaunch: options?.relaunch ?? false },
    options?.relaunch ? RELAUNCH_TIMEOUT_MS : ACTION_TIMEOUT_MS,
    `${LOST} The change may still apply; list the keys to check.`,
  );
  const parsed = parseKeychainWrite(result.stdout);
  if (parsed) return parsed;
  throw new Error(lastStderrLine(result, fallback));
}

export function setIosKeychainValues(
  run: RunHostAction,
  udid: string,
  appId: string,
  values: Readonly<Record<string, string>>,
  options?: KeychainWriteOptions,
): Promise<KeychainWriteResult> {
  return write(
    run,
    "keychain.set",
    { ...target(udid, appId, options), values },
    options,
    "Could not set the keychain values.",
  );
}

export function deleteIosKeychainValues(
  run: RunHostAction,
  udid: string,
  appId: string,
  keys: readonly string[],
  options?: KeychainWriteOptions,
): Promise<KeychainWriteResult> {
  return write(
    run,
    "keychain.delete",
    { ...target(udid, appId, options), keys: [...keys] },
    options,
    "Could not delete the keychain values.",
  );
}
