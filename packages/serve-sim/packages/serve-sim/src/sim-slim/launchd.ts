// Applies a slim profile through `simctl spawn launchctl`: `disable` persists across reboots
// (iOS 18.5+), `bootout` unloads now. Each function takes the simctl runner, so tests pass a fake.
import { execFile } from "child_process";
import { promisify } from "util";
import { simctl } from "../simctl";
import { DEFAULT_SLIM_CATEGORIES, SLIM_CATEGORIES, type SlimCategory, type SlimProfile } from "./catalog";

const execFileAsync = promisify(execFile);

type Run = (args: string[]) => Promise<string>;

/**
 * `simctl` under the utility QoS clamp, so a slim yields the CPU to a starting stream. On a busy
 * host a yielding call can take tens of seconds, hence the long timeout.
 */
export async function simctlLowPriority(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("taskpolicy", ["-c", "utility", "xcrun", "simctl", ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return stdout.trim();
}

type Failure = { label: string; error: string };

/** Labels `launchctl print-disabled` reports as disabled (`=> disabled` or `=> true`). */
export function parseDisabled(output: string): Set<string> {
  const disabled = new Set<string>();
  for (const match of output.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)\b/g)) disabled.add(match[1]!);
  return disabled;
}

/** Labels `launchctl list` reports, that is, loaded: with a PID when running, `-` when not. */
export function parseLoaded(output: string): Set<string> {
  const loaded = new Set<string>();
  for (const line of output.split("\n")) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label && /^(\d+|-)$/.test(pid ?? "")) loaded.add(label);
  }
  return loaded;
}

const launchctl = (run: Run, udid: string, ...args: string[]) => run(["spawn", udid, "launchctl", ...args]);

async function readServices(udid: string, run: Run): Promise<{ disabled: Set<string>; loaded: Set<string> }> {
  const [disabled, loaded] = await Promise.all([
    launchctl(run, udid, "print-disabled", "system"),
    launchctl(run, udid, "list"),
  ]);
  return { disabled: parseDisabled(disabled), loaded: parseLoaded(loaded) };
}

/** `launchctl <verb> system/<label>` for each label, `workers` at a time. */
async function launchctlEach(udid: string, verb: string, labels: string[], run: Run, workers = 4): Promise<{ done: string[]; failed: Failure[] }> {
  const done: string[] = [];
  const failed: Failure[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, labels.length) }, async () => {
    while (next < labels.length) {
      const label = labels[next++]!;
      try {
        await launchctl(run, udid, verb, `system/${label}`);
        done.push(label);
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        failed.push({ label, error: String(stderr || error).trim().split("\n")[0]!.slice(0, 200) });
      }
    }
  }));
  return { done: done.sort(), failed };
}

export interface SlimResult {
  /** Newly disabled in this call. */
  disabled: string[];
  /** Were loaded and are now booted out, which stops the running ones. */
  unloaded: string[];
  failed: Failure[];
}

/**
 * Disables the profile's services, then reads them again: that checks each disable took, and
 * catches services loaded meanwhile (an app launching next to the slim), which are unloaded too.
 */
export async function slimSimulator(udid: string, profile: SlimProfile, run: Run = simctl, workers = 4): Promise<SlimResult> {
  const before = await readServices(udid, run);
  const disable = await launchctlEach(udid, "disable", profile.labels.filter((l) => !before.disabled.has(l)), run, workers);
  const after = disable.done.length ? await readServices(udid, run) : before;
  const notTaken = disable.done.filter((l) => !after.disabled.has(l))
    .map((label) => ({ label, error: "disable did not take: not in print-disabled" }));
  const failed = [...disable.failed, ...notTaken];
  const skip = new Set(failed.map((f) => f.label));
  const unload = await launchctlEach(udid, "bootout", profile.labels.filter((l) => after.loaded.has(l) && !skip.has(l)), run, workers);
  return {
    disabled: disable.done.filter((l) => !skip.has(l)),
    unloaded: unload.done,
    failed: [...failed, ...unload.failed],
  };
}

/** Switches the profile's services back on. launchd starts them on demand or at the next boot. */
export async function restoreSimulator(udid: string, profile: SlimProfile, run: Run = simctl): Promise<{ enabled: string[]; failed: Failure[] }> {
  const { disabled } = await readServices(udid, run);
  const enable = await launchctlEach(udid, "enable", profile.labels.filter((l) => disabled.has(l)), run);
  return { enabled: enable.done, failed: enable.failed };
}

export interface SlimCategoryStatus {
  category: SlimCategory;
  inDefault: boolean;
  /** How many of the category's services are disabled and not loaded on the device. */
  off: number;
  /** Disabled but still loaded, so launchd can still start them on demand. */
  disabledButLoaded: number;
}

export async function slimStatus(udid: string, run: Run = simctl): Promise<SlimCategoryStatus[]> {
  const { disabled, loaded } = await readServices(udid, run);
  return SLIM_CATEGORIES.map((category) => ({
    category,
    inDefault: DEFAULT_SLIM_CATEGORIES.includes(category.id),
    off: category.labels.filter((l) => disabled.has(l) && !loaded.has(l)).length,
    disabledButLoaded: category.labels.filter((l) => disabled.has(l) && loaded.has(l)).length,
  }));
}

export function describeSlim(udid: string, profile: SlimProfile, result: SlimResult): string {
  const failed = result.failed.length ? `, ${result.failed.length} failed` : "";
  return `[slim] ${udid}: ${profile.categories.join(",")}: ${result.disabled.length} disabled, ${result.unloaded.length} unloaded${failed}`;
}
