import { existsSync, readFileSync, unlinkSync } from "fs";
import { basename, join } from "path";
import {
  capabilitiesToApply,
  capabilityDefinition,
  type CapabilityContext,
  type CapabilityDefinition,
  type CapabilityOverrides,
} from "./capabilities";
import {
  prepareCapability,
  notifyPreparationFailure,
  rollbackPreparations,
  type CapabilityPreparation,
} from "./capability-resources";
import {
  capabilityConfigPath,
  managedStartupDylibs,
  writeManagedStartupDylibs,
  commitCapabilityConfig,
  renderCapabilityConfig,
} from "./capability-config";
import {
  type Capability,
  type RecordedCapability,
  type LaunchState,
  readLaunchState,
  clearLaunchState,
  writeLaunchState,
  ownerIsGone,
} from "./launch-state";
import {
  withLaunchStateLock,
  withLaunchStateLockSync,
  waitForLaunchUpdates,
  LOCK_POLL_MS,
} from "./launch-state-lock";
import { dirnameOf } from "./runtime";
import { simctl, simctlSync } from "./simctl";

export {
  type Capability,
  type RecordedCapability,
  readLaunchState,
  clearLaunchState,
} from "./launch-state";
export {
  MAX_CONFIG_BYTES,
  formatCapabilityConfig,
  renderCapabilityConfig,
  capabilityConfigPath,
} from "./capability-config";
export { waitForLaunchUpdates } from "./launch-state-lock";

const CAPABILITY_LOADER_NAME = "libServeSimCapabilityLoader.dylib";
const INSERT = "DYLD_INSERT_LIBRARIES";
const CONFIG_VAR = "SERVE_SIM_CAPABILITIES_CONFIG";
const TERMINATE_TIMEOUT_MS = 15_000;

function releaseLaunchStateUnlocked(
  udid: string, ownerPid: number, onRelease?: (capability: RecordedCapability) => void,
): boolean {
  const previous = readLaunchState(udid, ownerPid);
  if (!previous) return false;
  const kept = Object.fromEntries(
    Object.entries(previous.capabilities).filter(([, record]) => record.ownerPid !== ownerPid),
  );
  const sessionPids = previous.sessionPids?.filter((pid) => pid !== ownerPid);
  for (const record of Object.values(previous.capabilities)) {
    if (record.ownerPid === ownerPid) onRelease?.(record);
  }
  if (Object.keys(kept).length === 0 && !sessionPids?.length) {
    clearLaunchState(udid);
    return false;
  }
  const state: LaunchState = { ...previous, capabilities: kept, ...(sessionPids ? { sessionPids } : {}) };
  writeLaunchState(udid, state);
  commitCapabilityConfig(udid, renderCapabilityConfig(state));
  return true;
}

export function releaseLaunchState(udid: string, ownerPid: number): boolean {
  return withLaunchStateLockSync(udid, () => releaseLaunchStateUnlocked(udid, ownerPid));
}

export function releaseSessionSync(
  udid: string,
  ownerPid: number,
  onRelease: (capability: RecordedCapability) => void,
): void {
  withLaunchStateLockSync(udid, () => {
    const previousStartup = managedStartupDylibs(udid);
    const othersRemain = releaseLaunchStateUnlocked(udid, ownerPid, onRelease);
    if (!othersRemain) removeCapabilityLoaderSync(udid);
    else removeReleasedStartupSync(udid, previousStartup);
    armedHere.delete(udid);
  });
}

export async function releaseSession(
  udid: string,
  ownerPid: number,
  onRelease: (capability: RecordedCapability) => void,
): Promise<void> {
  await waitForLaunchUpdates();
  await withLaunchStateLock(udid, async () => {
    const previousStartup = managedStartupDylibs(udid);
    const othersRemain = releaseLaunchStateUnlocked(udid, ownerPid, onRelease);
    if (!othersRemain) removeCapabilityLoaderSync(udid);
    else removeReleasedStartupSync(udid, previousStartup);
    armedHere.delete(udid);
  });
}

export async function stopLaunchSession(
  udid: string,
  ownerPid: number,
  onRelease: (capability: RecordedCapability) => void,
): Promise<void> {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) {
    throw new Error(`Cannot stop session with invalid owner pid ${ownerPid}.`);
  }
  try { process.kill(ownerPid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 60_000;
  while (!ownerIsGone(ownerPid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Session ${ownerPid} on ${udid} did not stop within 60 seconds. Its launch state was preserved; wait for shutdown to finish and retry.`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  await releaseSession(udid, ownerPid, onRelease);
}

export function capabilityLoaderDir(): string {
  return join(dirnameOf(import.meta.url), "..", "dist", "capability-loader");
}

/**
 * `SIMCTL_CHILD_*` variables reach the app simctl launches. The insert has to
 * carry the capability dylib itself, so a swizzle is in place before the app's
 * own code runs, and the capability loader, because simctl's value replaces the
 * device-wide one for this process and would otherwise drop every other
 * capability.
 */
export function childLaunchEnv(
  dylib: string,
  capabilityEnv: Record<string, string>,
): Record<string, string> {
  return {
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: [dylib, capabilityLoaderPath()].join(":"),
    ...Object.fromEntries(
      Object.entries(capabilityEnv).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]),
    ),
  };
}

const armedHere = new Set<string>();

export function devicesArmedHere(): string[] {
  return [...armedHere];
}

// DYLD_INSERT_LIBRARIES is a colon-separated list. Another tool may already
// have one set, so add and remove only our own entry.
function isCapabilityLoaderPath(path: string): boolean {
  const name = basename(path);
  // Recognize sessions started before the capability-loader rename.
  return name === CAPABILITY_LOADER_NAME || name === "libServeSimTrampoline.dylib";
}

function withoutOurs(current: string, startupDylibs: string[] = []): string[] {
  return current
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !isCapabilityLoaderPath(entry) && !startupDylibs.includes(entry));
}

async function readInsert(udid: string): Promise<string> {
  return (await simctl(["spawn", udid, "launchctl", "getenv", INSERT], 15_000)).trim();
}

function startupDylibs(capabilities: Record<string, Capability>): string[] {
  return Object.values(capabilities)
    .filter((capability) => capability.loadPhase === "startup" || capability.loadPhase === "startupAndDeferred")
    .map((capability) => capability.dylib);
}

async function armInsert(
  udid: string,
  dylib: string,
  capabilities: Record<string, Capability> = readLaunchState(udid)?.capabilities ?? {},
  previousStartup = managedStartupDylibs(udid),
): Promise<void> {
  const desired = startupDylibs(capabilities);
  const retained = withoutOurs(await readInsert(udid), previousStartup);
  const next = [...new Set([...retained, dylib, ...desired])].join(":");
  writeManagedStartupDylibs(udid, [...previousStartup, ...desired]);
  await simctl(["spawn", udid, "launchctl", "setenv", CONFIG_VAR, capabilityConfigPath(udid)], 15_000);
  await simctl(["spawn", udid, "launchctl", "setenv", INSERT, next], 15_000);
  writeManagedStartupDylibs(udid, desired);
  armedHere.add(udid);
}

export class CapabilityRollbackError extends AggregateError {}

interface CapabilityLaunchSnapshot {
  config: string | null;
  configPath: string;
  insert: string;
  startupDylibs: string[];
}

async function snapshotCapabilityLaunch(udid: string): Promise<CapabilityLaunchSnapshot> {
  let config: string | null = null;
  try {
    config = readFileSync(capabilityConfigPath(udid), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const startupDylibs = managedStartupDylibs(udid);
  const insert = await readInsert(udid);
  const configPath = (await simctl(["spawn", udid, "launchctl", "getenv", CONFIG_VAR], 15_000)).trim();
  return { config, configPath, insert, startupDylibs };
}

async function restoreLaunchEnvironment(udid: string, name: string, value: string): Promise<void> {
  const update = value ? ["setenv", name, value] : ["unsetenv", name];
  await simctl(["spawn", udid, "launchctl", ...update], 15_000);
}

async function restoreCapabilityLaunch(
  udid: string,
  previous: CapabilityLaunchSnapshot,
  attemptedStartupDylibs: string[],
): Promise<void> {
  writeManagedStartupDylibs(udid, [...previous.startupDylibs, ...attemptedStartupDylibs]);
  if (previous.config === null) {
    unlinkSync(capabilityConfigPath(udid));
  } else {
    commitCapabilityConfig(udid, previous.config);
  }
  await restoreLaunchEnvironment(udid, CONFIG_VAR, previous.configPath);
  await restoreLaunchEnvironment(udid, INSERT, previous.insert);
  writeManagedStartupDylibs(udid, previous.startupDylibs);
}

function validateStartupDylibs(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new Error(
        `Startup capability not built: ${path}. Rebuild the native artifacts before enabling it.`,
      );
    }
  }
}

async function publishLaunchState(udid: string, state: LaunchState): Promise<void> {
  const config = renderCapabilityConfig(state);
  const desiredStartupDylibs = startupDylibs(state.capabilities);
  validateStartupDylibs(desiredStartupDylibs);
  const previous = await snapshotCapabilityLaunch(udid);
  // Running apps' loaders watch the config. Removals go out before arming, so an app launched
  // next cannot load a withdrawn capability. Additions wait until launchd accepts the insert, so
  // a failed update never lets a running app load something rollback cannot take back.
  const published = readLaunchState(udid)?.capabilities ?? {};
  const kept = Object.fromEntries(
    Object.entries(state.capabilities).filter(
      ([name, capability]) => JSON.stringify(published[name]) === JSON.stringify(capability),
    ),
  );
  const withdrawnOnly = renderCapabilityConfig({ ...state, capabilities: kept });

  try {
    commitCapabilityConfig(udid, withdrawnOnly);
    await armInsert(udid, capabilityLoaderPath(), state.capabilities, previous.startupDylibs);
    if (config !== withdrawnOnly) commitCapabilityConfig(udid, config);
    writeLaunchState(udid, state);
  } catch (error) {
    try {
      await restoreCapabilityLaunch(udid, previous, desiredStartupDylibs);
    } catch (rollbackError) {
      throw new CapabilityRollbackError(
        [error, rollbackError],
        `Could not restore capability launch state on ${udid}. Retry cleanup before launching apps.`,
      );
    }
    throw error;
  }
}

function removeReleasedStartupSync(udid: string, previousStartup: string[]): void {
  const desired = startupDylibs(readLaunchState(udid)?.capabilities ?? {});
  const removed = previousStartup.filter((path) => !desired.includes(path));
  if (removed.length === 0) return;
  const current = simctlSync(["spawn", udid, "launchctl", "getenv", INSERT], 15_000).trim();
  const next = current.split(":").filter((path) => !removed.includes(path)).join(":");
  simctlSync(next ? ["spawn", udid, "launchctl", "setenv", INSERT, next]
    : ["spawn", udid, "launchctl", "unsetenv", INSERT], 15_000);
  writeManagedStartupDylibs(udid, desired);
}

export function capabilityLoaderPath(): string {
  return join(capabilityLoaderDir(), CAPABILITY_LOADER_NAME);
}

/** Arm the loader and republish the recorded capabilities; rejects if publication fails. */
export async function rearmCapabilityLoader(udid: string): Promise<void> {
  const dylib = capabilityLoaderPath();
  if (!existsSync(dylib)) {
    throw new Error(
      `Capability loader not found at ${dylib}, so capabilities on ${udid} cannot be restored. ` +
        "Rebuild serve-sim's native artifacts and try again.",
    );
  }
  armedHere.add(udid);
  await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid) ?? { launchArgs: [], capabilities: {} };
    await publishLaunchState(udid, {
      ...previous,
      sessionPids: [...new Set([...(previous.sessionPids ?? []), process.pid])],
    });
  });
}

/** Best-effort rearmCapabilityLoader for startup: a missing loader is skipped, a failure logged. */
export async function armCapabilityLoader(udid: string): Promise<void> {
  if (!existsSync(capabilityLoaderPath())) return;
  try {
    await rearmCapabilityLoader(udid);
  } catch (error) {
    console.error(
      `Could not arm the capability loader on ${udid}: ` +
        `${error instanceof Error ? error.message : String(error)}. Another serve-sim may hold ` +
        `the device lock, or the state directory may not be writable. Enabling a capability arms ` +
        `it again, so retry after stopping other serve-sim processes on this device.`,
    );
  }
}

export function removeCapabilityLoaderSync(udid: string): void {
  try {
    simctlSync(["spawn", udid, "launchctl", "unsetenv", CONFIG_VAR], 15_000);
    const current = simctlSync(["spawn", udid, "launchctl", "getenv", INSERT], 15_000);
    const rest = withoutOurs(current, managedStartupDylibs(udid)).join(":");
    const clear = rest === ""
      ? ["spawn", udid, "launchctl", "unsetenv", INSERT]
      : ["spawn", udid, "launchctl", "setenv", INSERT, rest];
    simctlSync(clear, 15_000);
    writeManagedStartupDylibs(udid, []);
    try { unlinkSync(capabilityConfigPath(udid)); } catch {}
  } catch (error) {
    console.error(
      `Could not disarm the capability loader on ${udid}; it is still inserted into every ` +
        `app that simulator starts. Clear it with: xcrun simctl spawn ${udid} launchctl unsetenv ` +
        `DYLD_INSERT_LIBRARIES (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  armedHere.delete(udid);
}

export async function disarmStaleCapabilityLoader(udid: string): Promise<void> {
  const current = await simctl(["spawn", udid, "launchctl", "getenv", INSERT], 15_000).catch(() => null);
  if (current === null) {
    console.error(
      `Could not read the current insert on ${udid}, so a stale capability loader from an earlier ` +
        `session cannot be cleaned up. Capabilities may not load until it is.`,
    );
    return;
  }
  const ours = current
    .split(":")
    .map((entry) => entry.trim())
    .find(isCapabilityLoaderPath);
  if (!ours || existsSync(ours)) return;
  await removeCapabilityLoader(udid);
}

export async function removeCapabilityLoader(udid: string): Promise<void> {
  await simctl(["spawn", udid, "launchctl", "unsetenv", CONFIG_VAR], 15_000).catch(
    () => undefined,
  );
  const rest = withoutOurs(await readInsert(udid), managedStartupDylibs(udid)).join(":");
  const clear = rest === ""
    ? ["spawn", udid, "launchctl", "unsetenv", INSERT]
    : ["spawn", udid, "launchctl", "setenv", INSERT, rest];
  await simctl(clear, 15_000);
  writeManagedStartupDylibs(udid, []);
  try { unlinkSync(capabilityConfigPath(udid)); } catch {}
  armedHere.delete(udid);
}

export async function launchApp(
  udid: string,
  {
    bundleId,
    launchArgs = [],
    restart = false,
  }: { bundleId: string; launchArgs?: string[]; restart?: boolean },
): Promise<void> {
  await withLaunchStateLock(udid, async () => {
    const previous = readLaunchState(udid);
    const state: LaunchState = { ...previous, bundleId, launchArgs, capabilities: previous?.capabilities ?? {} };
    if (Object.keys(state.capabilities).length > 0) await publishLaunchState(udid, state);
    else {
      writeLaunchState(udid, state);
      commitCapabilityConfig(udid, renderCapabilityConfig(state));
    }
    if (restart) {
      await terminateForRelaunch(udid, bundleId);
    }
    await simctl(["launch", udid, bundleId, ...launchArgs]);
  });
}

export async function openUrlInApp(udid: string, bundleId: string, openUrl: string): Promise<void> {
  await preapproveUrlSchemeAsync(udid, bundleId, openUrl);
  await simctl(["openurl", udid, openUrl]);
}

type ConfigureOptions = {
  bundleId?: string | null;
  options?: Record<string, string>;
  enabled: boolean;
} & EnableOptions;

/**
 * Unused on `expo` today. Kept because #148, #102, and #53 import it; the
 * first of them to land makes it live. Remove the tag then.
 * @public
 */
export async function setCapabilityEnabled(
  udid: string,
  name: string,
  options: ConfigureOptions,
): Promise<void> {
  await configureCapability(udid, capabilityDefinition(name), options);
}

function hasForeignCapabilityOwner(
  udid: string,
  definition: CapabilityDefinition,
  ownerPid: number | null,
): boolean {
  if (!definition.exclusive) return false;
  const existing = readLaunchState(udid)?.capabilities[definition.name];
  return existing !== undefined && existing.ownerPid !== ownerPid;
}

function assertCapabilityOwner(udid: string, definition: CapabilityDefinition, ownerPid: number | null): void {
  if (hasForeignCapabilityOwner(udid, definition, ownerPid)) {
    throw new Error(
      `Capability ${definition.name} on ${udid} belongs to another session. ` +
      "Stop that session before enabling it here.",
    );
  }
}

export async function configureCapability(
  udid: string,
  definition: CapabilityDefinition,
  {
    bundleId = null,
    options = {},
    enabled,
    relaunch = true,
    ownerPid = process.pid,
  }: ConfigureOptions,
): Promise<void> {
  const context: CapabilityContext = { udid, bundleId, options, enabled };
  await withLaunchStateLock(udid, async () => {
    if (!enabled) {
      if (!hasForeignCapabilityOwner(udid, definition, ownerPid)) {
        await disableCapabilityUnlocked(udid, bundleId, definition.name, { relaunch: false });
      }
      await definition.setEnabled(context);
      return;
    }
    assertCapabilityOwner(udid, definition, ownerPid);
    const preparation = await prepareCapability(definition, context);
    if (!preparation) {
      throw new Error(`Capability ${definition.name} declined to start on ${udid}. Check its configuration and retry.`);
    }
    await publishPreparations(udid, bundleId, [preparation], ownerPid);
    if (relaunch) {
      const state = readLaunchState(udid);
      if (state) await relaunchTarget(udid, bundleId, state);
    }
  });
}

async function publishPreparations(
  udid: string,
  bundleId: string | null,
  preparations: CapabilityPreparation[],
  ownerPid: number | null = process.pid,
): Promise<void> {
  const previous = readLaunchState(udid);
  try {
    const capabilities = preparations.map(({ capability }) => capability);
    await enableCapabilitiesUnlocked(udid, bundleId, capabilities, { relaunch: false, ownerPid });
  } catch (error) {
    const observerErrors = notifyPreparationFailure(preparations, error);
    if (error instanceof CapabilityRollbackError) {
      if (observerErrors.length > 0) {
        throw new CapabilityRollbackError([error, ...observerErrors], error.message);
      }
      throw error;
    }
    await rollbackPreparations(udid, preparations, error, observerErrors);
    throw error;
  }
  try {
    for (const { resources } of preparations) resources.committed?.();
  } catch (error) {
    const observerErrors = notifyPreparationFailure(preparations, error);
    try {
      if (previous) {
        await publishLaunchState(udid, previous);
      } else {
        // Nothing was armed before this publication. Publishing an empty state would still insert
        // the loader, with no session recorded as its owner, so take the loader out instead.
        await removeCapabilityLoader(udid);
        clearLaunchState(udid);
      }
    } catch (withdrawError) {
      throw new CapabilityRollbackError(
        [error, withdrawError, ...observerErrors],
        `Could not withdraw a failed capability on ${udid}; its resources were kept. Retry cleanup before launching apps.`,
      );
    }
    await rollbackPreparations(udid, preparations, error, observerErrors);
    throw error;
  }
}

export async function applyDefaultCapabilities(
  udid: string,
  bundleId: string | null,
  overrides: CapabilityOverrides = {},
): Promise<string[]> {
  return withLaunchStateLock(udid, async () => {
    const preparations: CapabilityPreparation[] = [];
    for (const definition of capabilitiesToApply(overrides)) {
      try {
        assertCapabilityOwner(udid, definition, process.pid);
        const prepared = await prepareCapability(definition, { udid, bundleId, options: {}, enabled: true });
        if (prepared) preparations.push(prepared);
      } catch (error) {
        console.error(`Capability ${definition.name} could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await publishPreparations(udid, bundleId, preparations);
    const applied = preparations.map(({ capability }) => capability.name);
    for (const name of overrides.enable ?? []) {
      if (!applied.includes(name)) console.error(`Capability ${name} was requested but did not apply on ${udid}.`);
    }
    return applied;
  });
}

export function isCapabilityEnabled(udid: string, name: string): boolean {
  const state = readLaunchState(udid);
  return state !== null && name in state.capabilities;
}

export function listCapabilities(udid: string): string[] {
  const state = readLaunchState(udid);
  if (!state) return [];
  return Object.values(state.capabilities)
    .map((capability) => capability.name)
    .sort();
}

/**
 * `relaunch: false` records the capability for a caller that launches it itself.
 * `ownerPid: null` records one that outlives the command enabling it.
 */
export type EnableOptions = { relaunch?: boolean; ownerPid?: number | null };

export async function enableCapabilities(
  udid: string,
  bundleId: string | null,
  capabilities: Capability[],
  options: EnableOptions = {},
): Promise<void> {
  await withLaunchStateLock(udid, () => enableCapabilitiesUnlocked(udid, bundleId, capabilities, options));
}

async function enableCapabilitiesUnlocked(
  udid: string,
  bundleId: string | null,
  capabilities: Capability[],
  { relaunch = true, ownerPid = process.pid }: EnableOptions = {},
): Promise<void> {
  if (capabilities.length === 0) return;
  const dylib = capabilityLoaderPath();
  if (!existsSync(dylib)) {
    throw new Error(
      `Capability loader not built: ${dylib} is missing. Run \`bun run packages/serve-sim/build.ts\` ` +
        `to build the native artifacts, then retry.`,
    );
  }

  const previous = readLaunchState(udid);
  const added = Object.fromEntries(
    capabilities.map((capability) => [
      capability.name,
      { ...capability, bundleId, ownerPid },
    ]),
  );
  const state: LaunchState = {
    ...(previous ?? { launchArgs: [], capabilities: {} }),
    capabilities: { ...previous?.capabilities, ...added },
  };
  await publishLaunchState(udid, state);
  if (relaunch) await relaunchTarget(udid, bundleId, state);
}

/** null when the check itself failed, which is not the same as "not running". */
async function isRunning(udid: string, bundleId: string): Promise<boolean | null> {
  const out = await simctl(["spawn", udid, "launchctl", "list"], 15_000).catch(() => null);
  if (out === null) return null;
  return out.includes(`UIKitApplication:${bundleId}`);
}

async function terminateForRelaunch(udid: string, bundleId: string): Promise<void> {
  try {
    await simctl(["terminate", udid, bundleId], TERMINATE_TIMEOUT_MS);
    return;
  } catch {
  }
  const running = await isRunning(udid, bundleId);
  if (running === false) return;
  throw new Error(
    running === null
      ? `Could not stop ${bundleId} on ${udid}, and could not check whether it is still running. ` +
        `Relaunching now would do nothing if it is. Check the simulator and retry.`
      : `Could not stop ${bundleId} on ${udid}, so it cannot be relaunched with its capabilities ` +
        `loaded. simctl terminate did not take effect within ${TERMINATE_TIMEOUT_MS / 1000}s. ` +
        `Stop the app yourself and retry.`,
  );
}

async function relaunchTarget(
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

export async function disableCapability(
  udid: string,
  bundleId: string | null,
  name: string,
  options: EnableOptions = {},
): Promise<void> {
  await withLaunchStateLock(udid, () => disableCapabilityUnlocked(udid, bundleId, name, options));
}

async function disableCapabilityUnlocked(
  udid: string,
  bundleId: string | null,
  name: string,
  { relaunch = true }: EnableOptions = {},
): Promise<void> {
  const previous = readLaunchState(udid);
  if (!previous || !(name in previous.capabilities)) {
    if (managedStartupDylibs(udid).length > 0) {
      await publishLaunchState(udid, previous ?? { launchArgs: [], capabilities: {} });
    }
    return;
  }
  const rest = Object.fromEntries(
    Object.entries(previous.capabilities).filter(([key]) => key !== name),
  );
  const state: LaunchState = { ...previous, capabilities: rest };
  await publishLaunchState(udid, state);
  if (relaunch) await relaunchTarget(udid, bundleId, state);
}

const URL_SCHEME_APPROVAL_DOMAIN = "com.apple.launchservices.schemeapproval";
const URL_SCHEME_APPROVAL_KEY_PREFIX = "com.apple.CoreSimulator.CoreSimulatorBridge-->";

async function preapproveUrlSchemeAsync(
  udid: string,
  bundleId: string,
  openUrl: string,
): Promise<void> {
  const scheme = new URL(openUrl).protocol.slice(0, -1);
  if (scheme === "http" || scheme === "https") return;
  try {
    await simctl([
      "spawn", udid, "defaults", "write",
      URL_SCHEME_APPROVAL_DOMAIN,
      `${URL_SCHEME_APPROVAL_KEY_PREFIX}${scheme}`,
      "-string", bundleId,
    ], 15_000);
  } catch {
    console.error(
      `Could not pre-approve the ${scheme}: URL scheme for ${bundleId}. Opening the URL anyway; ` +
        `the Simulator may ask you to confirm it.`,
    );
  }
}
