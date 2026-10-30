import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertResidentMetadataPresent,
  capabilityConfigPath,
  capabilityLoaderDir,
  capabilityLoaderPath,
  commitCapabilityConfig,
  formatCapabilityConfig,
  renderCapabilityConfig,
  managedStartupDylibs,
  writeManagedStartupDylibs,
} from "./capability-config";
import {
  canonicalDeviceKey,
  isSimulatorUdid,
  readLaunchState,
  writeLaunchState,
  clearLaunchState,
  type RecordedCapability,
  type SimulatorBootIdentity,
} from "./launch-state";
import { withLaunchStateLock } from "./launch-state-lock";
import { stateDir } from "./state";
import { getDeviceState } from "./device";
import { BOOT_TIMEOUT_MS, simctl } from "./simctl";
import { simulatorBootIdentitySchema, type ResidentEgressRecord } from "./resident-egress-state";

export type EgressPolicy = "passthrough" | "block";
type ControlResult = {
  policy: EgressPolicy;
  warmupPolicy: EgressPolicy;
  publishedGeneration: number;
};

/** Controller publication status; process observation is checked separately. */
function parseControlResult(value: unknown, warmup: EgressPolicy): ControlResult {
  const result = value as Partial<ControlResult> | null;
  if (
    !result ||
    !Number.isSafeInteger(result.publishedGeneration) ||
    Number(result.publishedGeneration) < 1 ||
    (result.policy !== "passthrough" && result.policy !== "block") ||
    result.warmupPolicy !== warmup
  )
    throw new Error("Invalid resident egress control state");
  return result as ControlResult;
}

const execute = promisify(execFile);
const artifacts = [
  "libServeSimEgressGuard.dylib",
  "libServeSimCapabilityLoader.dylib",
  "serve-sim-egress-control",
  "serve-sim-egress-boot-identity",
  "serve-sim-egress-check",
] as const;

function canonicalDevice(udid: string): string {
  if (!isSimulatorUdid(udid)) throw new Error("Resident egress requires an exact Simulator UDID");
  return udid.toUpperCase();
}

function digest(path: string): string {
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== process.getuid!())
    throw new Error(`Invalid resident egress artifact: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
async function helper(path: string, args: string[]): Promise<unknown> {
  const { stdout } = await execute(path, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 8192,
  });
  return JSON.parse(stdout);
}
function pageIdentity(path: string): string {
  const file = lstatSync(path, { bigint: true });
  if (
    !file.isFile() ||
    file.size !== 4096n || // EG_PAGE_BYTES in Sources/ServeSimEgressGuard/policy.h
    file.uid !== BigInt(process.getuid!()) ||
    (file.mode & 0o777n) !== 0o600n
  )
    throw new Error("Invalid resident egress control page");
  return `${file.dev}:${file.ino}`;
}
async function simulatorEgressBoot(
  udid: string,
  directory: string,
): Promise<SimulatorBootIdentity | null> {
  udid = canonicalDevice(udid);
  const result = await helper(join(directory, "serve-sim-egress-boot-identity"), [udid]);
  if (result === null) return null;
  const boot = simulatorBootIdentitySchema.safeParse(result);
  if (!boot.success) throw new Error("Invalid Simulator boot identity from egress helper");
  return boot.data;
}
function sameBoot(a: SimulatorBootIdentity | null, b: SimulatorBootIdentity | null): boolean {
  return !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt;
}
export function residentEgress(udid: string): ResidentEgressRecord | undefined {
  udid = canonicalDeviceKey(udid);
  const state = readLaunchState(udid);
  assertResidentMetadataPresent(udid);
  // readLaunchState validates resident records at the disk boundary.
  return state?.capabilities.egressGuard?.resident
    ? (state.capabilities.egressGuard as ResidentEgressRecord)
    : undefined;
}

async function control(
  guard: ResidentEgressRecord,
  ...args: ["status"] | ["set", EgressPolicy]
): Promise<ControlResult> {
  return parseControlResult(
    await helper(join(dirname(guard.dylib), "serve-sim-egress-control"), [
      args[0]!,
      guard.env.SERVE_SIM_EGRESS_POLICY_FILE,
      ...args.slice(1),
    ]),
    guard.resident.warmupPolicy,
  );
}

/** These operations replace the boot or its insert list and cannot preserve enrollment. */
export function assertNoResidentEgress(udid: string, operation: string): void {
  if (residentEgress(udid))
    throw new Error(
      `${operation} is unavailable while resident egress is enrolled; preserve its boot and guard.`,
    );
}

/** Uses existing session/capability owners; boot enrollment itself has no job owner. */
export function assertEgressSessionOwner(udid: string, ownerPid = process.pid): void {
  const state = readLaunchState(udid);
  const owners = [
    ...(state?.sessionPids ?? []),
    ...Object.values(state?.capabilities ?? {}).flatMap((capability) =>
      capability.resident || capability.ownerPid === null ? [] : [capability.ownerPid],
    ),
  ];
  if (owners.some((pid) => pid !== ownerPid))
    throw new Error(
      `Resident egress on ${udid} belongs to another session; stop it before changing policy.`,
    );
}
export async function checkResidentEgress(udid: string): Promise<ResidentEgressRecord> {
  udid = canonicalDevice(udid);
  const guard = residentEgress(udid);
  const saved = guard?.resident;
  if (!guard || !saved?.boot || !saved.assets)
    throw new Error(
      "No compatible resident egress enrollment for this Simulator boot; use a cold start",
    );
  await checkAssets(udid, guard);
  if (!sameBoot(saved.boot, await simulatorEgressBoot(udid, dirname(guard.dylib))))
    throw new Error("Simulator boot changed; the old resident egress enrollment cannot be reused");
  return guard;
}

/** Requires the device lock. Verifies a fresh process uses this boot's pinned page. */
export async function verifyResidentEgressPolicy(
  udid: string,
  policy: EgressPolicy,
  guard?: ResidentEgressRecord,
): Promise<void> {
  guard ??= await checkResidentEgress(udid);
  const directory = dirname(guard.dylib);
  const page = guard.env.SERVE_SIM_EGRESS_POLICY_FILE;
  const before = await control(guard, "status");
  const observed = JSON.parse(
    await simctl(
      ["spawn", udid, join(directory, "serve-sim-egress-check"), guard.dylib, page],
      15_000,
    ),
  ) as Partial<ControlResult> & { pageIdentity?: string };
  if (
    before.policy !== policy ||
    observed.policy !== policy ||
    observed.publishedGeneration !== before.publishedGeneration ||
    observed.pageIdentity !== guard.resident.assets!.pageIdentity
  )
    throw new Error("Resident egress startup self-check did not observe the published policy");
  await checkResidentEgress(udid);
}

/** Read under the device lock; status never enrolls a guard or changes policy. */
export async function readResidentEgressPolicy(udid: string): Promise<EgressPolicy> {
  const guard = await checkResidentEgress(udid);
  return (await control(guard, "status")).policy;
}

async function checkAssets(udid: string, guard: RecordedCapability): Promise<void> {
  const saved = guard.resident;
  if (!saved?.assets) throw new Error("Resident egress asset identity is unavailable");
  const expected = formatCapabilityConfig({ egressGuard: guard }).trimEnd();
  let startup = "";
  try {
    startup = readFileSync(capabilityConfigPath(udid), "utf8");
  } catch (error) {
    throw new Error("Resident egress startup record is unavailable", { cause: error });
  }
  if (!startup.split("\n").includes(expected))
    throw new Error("Resident egress startup record changed");
  const directory = dirname(guard.dylib);
  for (const name of artifacts) {
    if (digest(join(directory, name)) !== saved.assets.hashes[name])
      throw new Error("Resident egress artifact changed; preserve the old boot assets");
  }
  if (pageIdentity(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!) !== saved.assets.pageIdentity)
    throw new Error("Resident egress page was replaced; preserve the original mapping");
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new Error("Cannot establish resident Simulator boot death", { cause: error });
  }
  return false;
}

function requireAbsentProcess(pid: number): void {
  if (!processIsAbsent(pid))
    throw new Error("Resident Simulator boot process is still alive; retain its enrollment");
}

// @ref LLP 0007.000#resident-boot-reclamation — only proven boot death permits withdrawing resident enrollment
/** Only called under the device lock. No caller assertion substitutes for boot-death checks. */
async function reclaimDeadResidentEgress(udid: string, guard: RecordedCapability): Promise<void> {
  const boot = guard.resident?.boot;
  if (!boot) throw new Error("Pending resident boot identity is uncertain; retain its enrollment");
  requireAbsentProcess(boot.pid);
  const directory = dirname(guard.dylib);
  const file = lstatSync(directory);
  if (
    !file.isDirectory() ||
    file.uid !== process.getuid!() ||
    (file.mode & 0o777) !== 0o700 ||
    dirname(resolve(directory)) !== resolve(stateDir()) ||
    !new RegExp(`^egress-${udid}-[A-Za-z0-9]{6}$`).test(basename(directory)) ||
    guard.env?.SERVE_SIM_EGRESS_POLICY_FILE !== join(directory, "policy")
  )
    throw new Error("Invalid resident asset directory; retain its enrollment");
  await checkAssets(udid, guard);
  if (
    (await simulatorEgressBoot(udid, directory)) ||
    (await getDeviceState(udid)) !== "Shutdown" ||
    (await simulatorEgressBoot(udid, directory))
  )
    throw new Error("Resident Simulator boot death is unconfirmed; retain its enrollment");
  requireAbsentProcess(boot.pid);

  const previous = readLaunchState(udid)!;
  const configPath = capabilityConfigPath(udid);
  const previousConfig = readFileSync(configPath, "utf8");
  const previousInserts = managedStartupDylibs(udid);
  const capabilities = { ...previous.capabilities };
  delete capabilities.egressGuard;
  const next = { ...previous, capabilities };
  // Generic publication forbids withdrawing a resident record. This narrow exception follows
  // native boot-death checks and preserves every unrelated capability and insert.
  const writeConfig = (contents: string) => {
    const temporary = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temporary, contents);
    renameSync(temporary, configPath);
  };
  try {
    writeConfig(renderCapabilityConfig(next));
    writeManagedStartupDylibs(
      udid,
      previousInserts.filter((path) => path !== guard.dylib),
    );
    writeLaunchState(udid, next);
  } catch (error) {
    const failures: unknown[] = [error];
    for (const restore of [
      () => writeConfig(previousConfig),
      () => writeManagedStartupDylibs(udid, previousInserts),
      () => writeLaunchState(udid, previous),
    ]) {
      try {
        restore();
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(failures, "Resident retirement and rollback failed");
    throw error;
  }
  const failures: unknown[] = [];
  // No recursion: stray files are retained and cleanup errors stop this preparation.
  for (const name of [...artifacts, "policy"]) {
    try {
      unlinkSync(join(directory, name));
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, `Could not remove retired resident assets in ${directory}`);
}

/** Returns whether a new enrollment needs booting; a matching live enrollment is retained. */
export async function prepareResidentEgress(udid: string, policy: EgressPolicy): Promise<boolean> {
  udid = canonicalDevice(udid);
  return withLaunchStateLock(udid, () => prepareResidentEgressUnlocked(udid, policy));
}

async function prepareResidentEgressUnlocked(udid: string, policy: EgressPolicy): Promise<boolean> {
  assertEgressSessionOwner(udid);
  const enrolled = residentEgress(udid);
  if (enrolled?.resident?.boot && !processIsAbsent(enrolled.resident.boot.pid)) {
    await checkResidentEgress(udid);
    return false;
  }
  if (enrolled) await reclaimDeadResidentEgress(udid, enrolled);
  const packaged = join(capabilityLoaderDir(), "..", "egress-guard");
  if (await simulatorEgressBoot(udid, packaged))
    throw new Error("Cannot retrofit resident egress into an already-booted Simulator");
  const previous = readLaunchState(udid);
  mkdirSync(stateDir(), { recursive: true });
  const directory = mkdtempSync(join(stateDir(), `egress-${udid}-`));
  const page = join(directory, "policy");
  const owned: string[] = [];
  let recorded = false;
  try {
    const hashes: Record<string, string> = {};
    for (const name of artifacts) {
      const source =
        name === "libServeSimCapabilityLoader.dylib"
          ? capabilityLoaderPath()
          : join(packaged, name);
      const destination = join(directory, name);
      copyFileSync(source, destination);
      owned.push(destination);
      chmodSync(destination, name.endsWith(".dylib") ? 0o400 : 0o500);
      hashes[name] = digest(destination);
    }
    owned.push(page);
    await helper(join(directory, "serve-sim-egress-control"), ["create", page, policy]);
    const guard: RecordedCapability = {
      name: "egressGuard",
      scope: "allProcesses",
      loadPhase: "startup",
      ownerPid: null,
      bundleId: null,
      dylib: join(directory, artifacts[0]),
      env: { SERVE_SIM_EGRESS_POLICY_FILE: page },
      resident: {
        boot: null,
        warmupPolicy: policy,
        assets: { hashes, pageIdentity: pageIdentity(page) },
      },
    };
    // Enrollment precedes config publication and boot; it is not an admission acknowledgement.
    writeLaunchState(udid, {
      ...(previous ?? { launchArgs: [], capabilities: {} }),
      capabilities: { ...previous?.capabilities, egressGuard: guard },
    });
    recorded = true;
    // Config publication is last and atomic: failure leaves the previous config intact.
    commitCapabilityConfig(udid, renderCapabilityConfig(readLaunchState(udid)!));
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      if (recorded) {
        writeLaunchState(udid, previous ?? { launchArgs: [], capabilities: {} });
        if (!previous) clearLaunchState(udid);
      }
    } catch (cleanup) {
      failures.push(cleanup);
    }
    // Only this fresh preboot child's named files are eligible for cleanup. Never recurse.
    if (failures.length === 1) {
      for (const path of owned.reverse()) {
        try {
          unlinkSync(path);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cleanup);
        }
      }
      try {
        rmdirSync(directory);
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Egress preparation and cleanup failed; retain uncertain assets",
      );
    throw error;
  }
  return true;
}

/** Called with the device lock after our strict boot, retaining assets on failure. */
async function bindResidentEgressBoot(
  udid: string,
  expected: SimulatorBootIdentity,
): Promise<void> {
  assertEgressSessionOwner(udid);
  const state = readLaunchState(udid);
  const guard = residentEgress(udid);
  if (!state || !guard?.resident || guard.resident.boot)
    throw new Error("No pending resident egress boot enrollment");
  await checkAssets(udid, guard);
  const boot = await simulatorEgressBoot(udid, dirname(guard.dylib));
  if (!boot) throw new Error("Cannot identify the selected Simulator boot");
  if (!sameBoot(boot, expected)) throw new Error("Simulator boot changed during resident startup");
  state.capabilities.egressGuard = { ...guard, resident: { ...guard.resident, boot } };
  writeLaunchState(udid, state);
}

/** Strict first boot only. An already-booted result cannot prove this enrollment was inserted. */
export async function bootPreparedResidentEgress(
  udid: string,
  assertActive: () => void = () => {},
): Promise<void> {
  udid = canonicalDevice(udid);
  await withLaunchStateLock(udid, () => bootPreparedResidentEgressUnlocked(udid, assertActive));
}

async function bootPreparedResidentEgressUnlocked(
  udid: string,
  assertActive: () => void,
): Promise<void> {
  assertEgressSessionOwner(udid);
  const guard = residentEgress(udid);
  if (!guard?.resident || guard.resident.boot)
    throw new Error("No pending resident egress boot enrollment");
  await checkAssets(udid, guard);
  if (await simulatorEgressBoot(udid, dirname(guard.dylib)))
    throw new Error("Cannot retrofit resident egress into an already-booted Simulator");
  assertActive();
  await simctl(["boot", udid], BOOT_TIMEOUT_MS);
  const started = await simulatorEgressBoot(udid, dirname(guard.dylib));
  if (!started) throw new Error("Cannot identify the newly started Simulator boot");
  assertActive();
  await simctl(["bootstatus", udid], BOOT_TIMEOUT_MS);
  assertActive();
  await bindResidentEgressBoot(udid, started);
  assertActive();
}

/** One transaction owns preparation, strict boot and policy admission. */
export async function startResidentEgress(
  udid: string,
  policy: EgressPolicy,
  assertActive: () => void,
): Promise<SimulatorBootIdentity> {
  udid = canonicalDevice(udid);
  return withLaunchStateLock(udid, async () => {
    assertActive();
    const needsBoot = await prepareResidentEgressUnlocked(udid, policy);
    const checked = needsBoot ? undefined : residentEgress(udid);
    if (needsBoot) await bootPreparedResidentEgressUnlocked(udid, assertActive);
    assertActive();
    await publishResidentEgressPolicyUnlocked(udid, policy, checked);
    assertActive();
    return { ...residentEgress(udid)!.resident.boot! };
  });
}

/** Publish and verify the selected boot's policy before returning. */
export async function publishResidentEgressPolicy(
  udid: string,
  policy: EgressPolicy,
): Promise<void> {
  udid = canonicalDevice(udid);
  await withLaunchStateLock(udid, () => publishResidentEgressPolicyUnlocked(udid, policy));
}

/** Requires the existing device lock; acknowledgement includes the native self-check. */
export async function publishResidentEgressPolicyUnlocked(
  udid: string,
  policy: EgressPolicy,
  checked?: ResidentEgressRecord,
): Promise<void> {
  assertEgressSessionOwner(udid);
  // Reuse only a check performed by this transaction under the same lock.
  const guard = checked ?? (await checkResidentEgress(udid));
  try {
    const result = await control(guard, "set", policy);
    if (result.policy !== policy) throw new Error("Egress policy publication failed");
    await verifyResidentEgressPolicy(udid, policy, guard);
  } catch (error) {
    try {
      await checkResidentEgress(udid);
      const blocked = await control(guard, "set", "block");
      if (blocked.policy !== "block") throw new Error("Blocking cleanup publication failed");
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Egress policy update and blocking cleanup failed; preserve the resident mapping",
      );
    }
    throw error;
  }
}
