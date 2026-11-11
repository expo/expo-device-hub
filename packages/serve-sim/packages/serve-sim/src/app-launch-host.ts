import { simctl } from "./simctl";
import type { LaunchState } from "./capabilities/runtime/state";

const TERMINATE_TIMEOUT_MS = 15_000;

/** null when the check itself failed, which is not the same as "not running". */
async function isRunning(udid: string, bundleId: string): Promise<boolean | null> {
  const out = await simctl(["spawn", udid, "launchctl", "list"], 15_000).catch(() => null);
  if (out === null) return null;
  return out.includes(`UIKitApplication:${bundleId}`);
}

export async function terminateForRelaunch(udid: string, bundleId: string): Promise<void> {
  let stopError: unknown;
  try {
    await simctl(["terminate", udid, bundleId], TERMINATE_TIMEOUT_MS);
    return;
  } catch (error) {
    stopError = error;
  }
  const running = await isRunning(udid, bundleId);
  if (running === false) return;
  // The cause keeps a timed-out stop recognizable, so app.launch can retry it.
  throw new Error(
    running === null
      ? `Could not stop ${bundleId} on ${udid}, and could not check whether it is still running. ` +
          `Relaunching now would do nothing if it is. Check the simulator and retry.`
      : `Could not stop ${bundleId} on ${udid}, so it cannot be relaunched with its capabilities ` +
          `loaded. simctl terminate did not take effect within ${TERMINATE_TIMEOUT_MS / 1000}s. ` +
          `Stop the app yourself and retry.`,
    { cause: stopError },
  );
}

export async function relaunchTarget(
  udid: string,
  bundleId: string | null,
  state: LaunchState,
): Promise<void> {
  const target = bundleId ?? state.bundleId;
  if (!target) return;
  const args = target === state.bundleId ? state.launchArgs : [];
  await terminateForRelaunch(udid, target);
  await simctl(["launch", udid, target, ...args]);
}

const URL_SCHEME_APPROVAL_DOMAIN = "com.apple.launchservices.schemeapproval";
const URL_SCHEME_APPROVAL_KEY_PREFIX = "com.apple.CoreSimulator.CoreSimulatorBridge-->";

export async function preapproveUrlSchemeAsync(
  udid: string,
  bundleId: string,
  openUrl: string,
): Promise<void> {
  const scheme = new URL(openUrl).protocol.slice(0, -1);
  if (scheme === "http" || scheme === "https") return;
  try {
    await writeUrlSchemeApprovalAsync(udid, bundleId, scheme);
  } catch {
    console.error(
      `Could not pre-approve the ${scheme}: URL scheme for ${bundleId}. Opening the URL anyway; ` +
        `the Simulator may ask you to confirm it.`,
    );
  }
}

export async function writeUrlSchemeApprovalAsync(
  udid: string,
  bundleId: string,
  scheme: string,
): Promise<void> {
  await simctl(
    [
      "spawn",
      udid,
      "defaults",
      "write",
      URL_SCHEME_APPROVAL_DOMAIN,
      `${URL_SCHEME_APPROVAL_KEY_PREFIX}${scheme}`,
      "-string",
      bundleId,
    ],
    15_000,
  );
}
