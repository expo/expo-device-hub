import { existsSync, unlinkSync } from "fs";
import { basename, join } from "path";
import {
  capabilitiesToApply,
  capabilityDefinition,
  forgetDisabledCapabilities,
  rememberDisabledCapabilities,
  type CapabilityContext,
  type CapabilityDefinition,
  type CapabilityOverrides,
} from "./capabilities";
import {
  capabilityConfigPath,
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
  const disabledCapabilities = Object.fromEntries(
    Object.entries(previous.disabledCapabilities ?? {})
      .map(([name, owners]) => [name, owners.filter((pid) => pid !== ownerPid)] as const)
      .filter(([, owners]) => owners.length > 0),
  );
  for (const record of Object.values(previous.capabilities)) {
    if (record.ownerPid === ownerPid) onRelease?.(record);
  }
  if (Object.keys(kept).length === 0 && !sessionPids?.length && Object.keys(disabledCapabilities).length === 0) {
    clearLaunchState(udid);
    return false;
  }
  const state: LaunchState = {
    ...previous, capabilities: kept,
    ...(sessionPids ? { sessionPids } : {}),
    disabledCapabilities,
  };
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
    const othersRemain = releaseLaunchStateUnlocked(udid, ownerPid, onRelease);
    if (!othersRemain) removeCapabilityLoaderSync(udid);
    armedHere.delete(udid);
    forgetDisabledCapabilities(udid);
  });
}

export async function releaseSession(
  udid: string,
  ownerPid: number,
  onRelease: (capability: RecordedCapability) => void,
): Promise<void> {
  await waitForLaunchUpdates();
  await withLaunchStateLock(udid, async () => {
    const othersRemain = releaseLaunchStateUnlocked(udid, ownerPid, onRelease);
    if (!othersRemain) removeCapabilityLoaderSync(udid);
    armedHere.delete(udid);
    forgetDisabledCapabilities(udid);
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

function withoutOurs(current: string): string[] {
  return current
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !isCapabilityLoaderPath(entry));
}

async function readInsert(udid: string): Promise<string> {
  return (await simctl(["spawn", udid, "launchctl", "getenv", INSERT], 15_000).catch(() => "")).trim();
}

async function armInsert(udid: string, dylib: string): Promise<void> {
  const next = [...withoutOurs(await readInsert(udid)), dylib].join(":");
  await simctl(["spawn", udid, "launchctl", "setenv", INSERT, next], 15_000);
  await simctl(["spawn", udid, "launchctl", "setenv", CONFIG_VAR, capabilityConfigPath(udid)], 15_000);
  armedHere.add(udid);
}

export function capabilityLoaderPath(): string {
  return join(capabilityLoaderDir(), CAPABILITY_LOADER_NAME);
}

export async function armCapabilityLoader(udid: string): Promise<void> {
  const dylib = capabilityLoaderPath();
  if (!existsSync(dylib)) return;
  armedHere.add(udid);
  try {
    await withLaunchStateLock(udid, async () => {
      const previous = readLaunchState(udid) ?? { launchArgs: [], capabilities: {} };
      const state: LaunchState = {
        ...previous,
        sessionPids: [...new Set([...(previous.sessionPids ?? []), process.pid])],
      };
      const config = renderCapabilityConfig(state);
      commitCapabilityConfig(udid, config);
      writeLaunchState(udid, state);
      await armInsert(udid, dylib);
    });
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
    const rest = withoutOurs(current).join(":");
    const clear = rest === ""
      ? ["spawn", udid, "launchctl", "unsetenv", INSERT]
      : ["spawn", udid, "launchctl", "setenv", INSERT, rest];
    simctlSync(clear, 15_000);
  } catch (error) {
    console.error(
      `Could not disarm the capability loader on ${udid}; it is still inserted into every ` +
        `app that simulator starts. Clear it with: xcrun simctl spawn ${udid} launchctl unsetenv ` +
        `DYLD_INSERT_LIBRARIES (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try { unlinkSync(capabilityConfigPath(udid)); } catch {}
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
  const rest = withoutOurs(await readInsert(udid)).join(":");
  const clear = rest === ""
    ? ["spawn", udid, "launchctl", "unsetenv", INSERT]
    : ["spawn", udid, "launchctl", "setenv", INSERT, rest];
  await simctl(clear, 15_000).catch(() => undefined);
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
    const config = renderCapabilityConfig(state);
    // Publish the config before launching the app.
    if (Object.keys(state.capabilities).length > 0) await armInsert(udid, capabilityLoaderPath());
    writeLaunchState(udid, state);
    commitCapabilityConfig(udid, config);
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

async function prepare(
  definition: CapabilityDefinition,
  context: CapabilityContext,
): Promise<Capability | null> {
  const prepared = await definition.setEnabled(context).catch((error: unknown) => {
    console.error(
      `Capability ${definition.name} could not be prepared and will not load: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  if (!prepared) return null;
  return {
    name: definition.name,
    dylib: prepared.dylib,
    env: prepared.env,
    scope: definition.scope,
    loadDelayMs: definition.loadDelayMs,
  };
}

/**
 * Unused on `expo` today. Kept because #148, #102, and #53 import it; the
 * first of them to land makes it live. Remove the tag then.
 * @public
 */
export async function setCapabilityEnabled(
  udid: string,
  capability: string | CapabilityDefinition,
  {
    bundleId = null,
    options = {},
    enabled,
    relaunch = true,
    ownerPid = process.pid,
    reuseIfEnabled = false,
    respectDisabledOverrides = false,
  }: {
    bundleId?: string | null;
    options?: Record<string, string>;
    enabled: boolean;
    reuseIfEnabled?: boolean;
    respectDisabledOverrides?: boolean;
  } & EnableOptions,
): Promise<void> {
  const definition =
    typeof capability === "string" ? capabilityDefinition(capability) : capability;
  const context: CapabilityContext = { udid, bundleId, options, enabled };

  await withLaunchStateLock(udid, async () => {
    if (enabled && respectDisabledOverrides && readLaunchState(udid)?.disabledCapabilities?.[definition.name]?.length) {
      throw new Error(`Capability ${definition.name} is disabled for this simulator session.`);
    }
    if (!enabled) {
      await definition.setEnabled(context);
      await disableCapabilityUnlocked(udid, bundleId, definition.name, { relaunch: false });
      return;
    }

    const capability = await prepare(definition, context);
    if (!capability) {
      throw new Error(
        `Capability ${definition.name} declined to start on ${udid}. It reported nothing to load, so there ` +
          `is nothing to enable. Check the message above for why.`,
      );
    }
    const previous = readLaunchState(udid);
    if (reuseIfEnabled && previous?.capabilities[definition.name]) {
      await armInsert(udid, capabilityLoaderPath());
      commitCapabilityConfig(udid, renderCapabilityConfig(previous));
      if (relaunch) await relaunchTarget(udid, bundleId, previous);
      return;
    }
    await enableCapabilitiesUnlocked(udid, bundleId, [capability], { relaunch, ownerPid });
  });
}

export async function applyDefaultCapabilities(
  udid: string,
  bundleId: string | null,
  overrides: CapabilityOverrides = {},
): Promise<string[]> {
  return withLaunchStateLock(udid, async () => {
    const definitions = capabilitiesToApply(overrides);
    rememberDisabledCapabilities(udid, overrides.disable ?? []);
    const previous = readLaunchState(udid);
    const disabledCapabilities = Object.fromEntries(
      Object.entries(previous?.disabledCapabilities ?? {})
        .map(([name, owners]) => [name, owners.filter((pid) => pid !== process.pid)] as const)
        .filter(([, owners]) => owners.length > 0),
    );
    for (const name of overrides.disable ?? []) {
      disabledCapabilities[name] = [...(disabledCapabilities[name] ?? []), process.pid];
    }
    if (previous || Object.keys(disabledCapabilities).length > 0) {
      writeLaunchState(udid, {
        ...(previous ?? { launchArgs: [], capabilities: {} }),
        disabledCapabilities,
      });
    }
    const resolved: Capability[] = [];
    for (const definition of definitions) {
      const capability = await prepare(definition, { udid, bundleId, options: {}, enabled: true });
      if (!capability) continue;
      resolved.push(capability);
    }
    await enableCapabilitiesUnlocked(udid, bundleId, resolved, { relaunch: false });
    const applied = resolved.map((capability) => capability.name);

    for (const name of overrides.enable ?? []) {
      if (applied.includes(name)) continue;
      console.error(
        `Capability ${name} was requested but did not apply on ${udid}.`,
      );
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
  const config = renderCapabilityConfig(state);
  await armInsert(udid, dylib);
  writeLaunchState(udid, state);
  commitCapabilityConfig(udid, config);
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
  if (!previous) return;
  if (!(name in previous.capabilities)) return;
  const rest = Object.fromEntries(
    Object.entries(previous.capabilities).filter(([key]) => key !== name),
  );
  const state: LaunchState = { ...previous, capabilities: rest };
  const config = renderCapabilityConfig(state);
  writeLaunchState(udid, state);
  commitCapabilityConfig(udid, config);
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
