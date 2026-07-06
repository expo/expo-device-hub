import { runSimctl } from "./simctl";

/** Build the `simctl delete <udid>` args. */
export function buildDeleteArgs(udid: string): string[] {
  return ["delete", udid];
}

/**
 * Run `xcrun simctl delete <udid>` and return whether it succeeded.
 * Never throws.
 */
export async function runSimctlDelete(udid: string): Promise<boolean> {
  return (await runSimctl(buildDeleteArgs(udid))) !== null;
}
