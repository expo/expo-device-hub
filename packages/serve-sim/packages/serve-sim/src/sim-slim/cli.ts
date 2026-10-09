// The `--slim-simulator` flag (a background slim per served device) and the `slim-simulator` command.
import { execSync } from "child_process";
import type { Command } from "commander";
import { resolveDevice } from "../device";
import { resolveSlimProfile, type SlimProfile } from "./catalog";
import { describeSlim, restoreSimulator, simctlLowPriority, slimSimulator, slimStatus } from "./launchd";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function reportFailures(failed: Array<{ label: string; error: string }>): void {
  for (const failure of failed) console.error(`[slim] ${failure.label}: ${failure.error}`);
}

export const SLIM_OPTION = [
  "--slim-simulator <profile>",
  "Switch off simulator services the stream does not need, in the background while streaming starts: " +
    "default, all, or a comma-separated list of categories (see `serve-sim slim-simulator --status`)",
] as const;

/** The profile `--slim-simulator` names, or undefined without the flag. Exits on an unknown category. */
export function parseSlimOption(value: string | undefined): SlimProfile | undefined {
  if (value === undefined) return undefined;
  try {
    return resolveSlimProfile(value);
  } catch (error) {
    console.error(message(error));
    process.exit(1);
  }
}

/**
 * Slims `udid` and returns at once: nothing waits on it, not readiness, the app launch, or the
 * stream. One call at a time at utility QoS, so it yields the CPU to the startup; never throws.
 */
export function startSlimInBackground(udid: string, profile: SlimProfile): void {
  const started = Date.now();
  slimSimulator(udid, profile, simctlLowPriority, 1).then(
    (result) => {
      console.error(`${describeSlim(udid, profile, result)} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      reportFailures(result.failed);
    },
    (error: unknown) => console.error(`[slim] ${udid}: ${message(error)}`),
  );
}

/** Every booted simulator, any runtime. */
function bootedDevices(): Array<{ udid: string; name: string }> {
  const output = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
  const data = JSON.parse(output) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
  return Object.values(data.devices).flat()
    .filter((device) => device.state === "Booted")
    .map(({ udid, name }) => ({ udid, name }));
}

/** `serve-sim slim-simulator`: apply, undo, or show the profile on one simulator. */
async function slimSimulatorCommand(opts: { device?: string; profile: string; undo?: boolean; status?: boolean }) {
  const profile = parseSlimOption(opts.profile)!;
  let udid: string;
  if (opts.device) {
    udid = resolveDevice(opts.device);
  } else {
    // Never guess between simulators: this changes the device until it is undone.
    const booted = bootedDevices();
    if (booted.length !== 1) {
      console.error(booted.length === 0
        ? "No booted simulator. Boot one or pass -d <udid|name>."
        : `${booted.length} simulators are booted (${booted.map((d) => d.name).join(", ")}). Pass -d <udid|name>.`);
      process.exit(1);
    }
    udid = booted[0]!.udid;
  }
  if (opts.status) {
    for (const { category, inDefault, off, disabledButLoaded } of await slimStatus(udid)) {
      const state = off === category.labels.length ? "off" : off + disabledButLoaded === 0 ? "on" : "partly off";
      const loaded = disabledButLoaded ? ` (${disabledButLoaded} disabled but still loaded)` : "";
      console.log(`${category.id.padEnd(13)} ${state.padEnd(10)} ${`${off}/${category.labels.length}`.padEnd(6)} ${inDefault ? "default" : "       "}  ${category.loses}${loaded}`);
    }
    return;
  }
  if (opts.undo) {
    const { enabled, failed } = await restoreSimulator(udid, profile);
    console.log(`[slim] ${udid}: ${profile.categories.join(",")}: ${enabled.length} enabled. ` +
      `Reboot the simulator to start them: xcrun simctl shutdown ${udid} && xcrun simctl boot ${udid}`);
    reportFailures(failed);
    process.exitCode = failed.length ? 1 : 0;
    return;
  }
  const result = await slimSimulator(udid, profile);
  console.log(describeSlim(udid, profile, result));
  reportFailures(result.failed);
  process.exitCode = result.failed.length ? 1 : 0;
}

export function registerSlimCommand(program: Command, deviceOpt: readonly [string, string]): void {
  program
    .command("slim-simulator")
    .description("Switch off simulator services a stream does not need, or back on with --undo")
    .option(...deviceOpt)
    .option("--profile <profile>", "default, all, or a comma-separated list of categories", "default")
    .option("--undo", "Switch the profile's services back on")
    .option("--status", "Show each category's state on the device and what an app loses without it")
    .action(slimSimulatorCommand);
}
