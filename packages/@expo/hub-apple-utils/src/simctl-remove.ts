import { type AppleUtilsResult, result } from "./errors";
import { runSimctl } from "./simctl";

/** Build the `simctl delete <udid>` args. */
export function buildDeleteArgs(udid: string): string[] {
  return ["delete", udid];
}

/**
 * Run `xcrun simctl delete <udid>` and return whether it succeeded.
 * Never throws.
 */
export async function runSimctlDelete(udid: string): Promise<AppleUtilsResult<boolean>> {
  const deleted = await runSimctl(buildDeleteArgs(udid));
  return result(deleted.value !== null, deleted.error);
}
