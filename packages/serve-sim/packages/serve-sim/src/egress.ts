import type { CapabilityDefinition, CapabilityOverrides } from "./capabilities";
import { withLaunchStateLock } from "./launch-state-lock";
import type { SimulatorBootIdentity } from "./launch-state";
import type { ResidentEgressRecord } from "./resident-egress-state";
import { readLaunchState } from "./launch-state";
import {
  assertEgressSessionOwner,
  checkResidentEgress,
  startResidentEgress,
  publishResidentEgressPolicyUnlocked,
  residentEgress,
  readResidentEgressPolicy,
  type EgressPolicy,
} from "./egress-resources";

export type EgressControlStatus = { available: false } | { available: true; enabled: boolean };

function assertPolicyControlOwner(udid: string): void {
  assertEgressSessionOwner(udid);
  if (!readLaunchState(udid)?.sessionPids?.includes(process.pid))
    throw new Error("This server does not own egress controls for this device.");
}

// @ref LLP 0007.000#right-panel-controls — policy actions never enroll or claim a session
export async function egressControlStatus(udid: string): Promise<EgressControlStatus> {
  udid = udid.toUpperCase();
  return withLaunchStateLock(udid, async () => {
    if (!residentEgress(udid)) return { available: false };
    assertPolicyControlOwner(udid);
    return { available: true, enabled: (await readResidentEgressPolicy(udid)) === "block" };
  });
}

export async function setEgressControl(
  udid: string,
  enabled: boolean,
): Promise<EgressControlStatus> {
  udid = udid.toUpperCase();
  return withLaunchStateLock(udid, async () => {
    assertPolicyControlOwner(udid);
    await publishResidentEgressPolicyUnlocked(udid, enabled ? "block" : "passthrough");
    return { available: true, enabled };
  });
}

export const egressGuardCapability: CapabilityDefinition = {
  name: "egressGuard",
  defaultEnabled: false,
  exclusive: true,
  scope: "allProcesses",
  loadPhase: "startup",
  async setEnabled() {
    throw new Error("Resident egress policy requires the strict startup or private adoption path.");
  },
};

export function egressPolicyOverride({
  enable = [],
  disable = [],
}: CapabilityOverrides): EgressPolicy | undefined {
  const on = enable.includes("egressGuard"),
    off = disable.includes("egressGuard");
  if (on && off)
    throw new Error("Choose either --enable egressGuard or --disable egressGuard, not both.");
  return on ? "block" : off ? "passthrough" : undefined;
}

export async function requiredEgressStartup(
  udid: string,
  policy: EgressPolicy | undefined,
  assertActive: () => void,
): Promise<SimulatorBootIdentity | null> {
  assertActive();
  const existing = residentEgress(udid);
  if (policy === undefined) {
    if (existing)
      throw new Error(
        "Resident egress startup requires an explicit --enable egressGuard or --disable egressGuard choice.",
      );
    return null;
  }
  return startResidentEgress(udid, policy, assertActive);
}

/** Host stream helpers observe the existing boot; they never own a policy choice. */
export async function checkResidentEgressBoot(
  udid: string,
  expected?: SimulatorBootIdentity,
): Promise<SimulatorBootIdentity | null> {
  if (!residentEgress(udid)) {
    if (expected) throw new Error(`Resident egress enrollment disappeared on ${udid}`);
    return null;
  }
  udid = udid.toUpperCase();
  return withLaunchStateLock(udid, async () => {
    const guard = await checkResidentEgress(udid);
    const boot = guard.resident!.boot!;
    if (expected && (boot.pid !== expected.pid || boot.startedAt !== expected.startedAt))
      throw new Error(`Simulator boot changed on ${udid}`);
    return { ...boot };
  });
}

async function compatibleEgressAdoption(
  udid: string,
  requested: unknown,
  ownerPid: number,
): Promise<{ policy: EgressPolicy; guard: ResidentEgressRecord } | undefined> {
  if (requested !== undefined && requested !== "block" && requested !== "passthrough")
    throw new Error("Invalid resident egress policy");
  const existing = residentEgress(udid);
  if (requested === undefined && !existing) return undefined;
  if (!existing) throw new Error("No compatible resident egress enrollment; use a cold start");
  if (requested === undefined)
    throw new Error(
      "Resident adoption requires an explicit --enable egressGuard or --disable egressGuard choice",
    );
  assertEgressSessionOwner(udid, ownerPid);
  const guard = await checkResidentEgress(udid);
  return { policy: requested, guard };
}

/** Compatibility only; policy publication happens after the claim. */
export async function preflightEgressAdoption(
  udid: string,
  requested: unknown,
  ownerPid: number,
  preparedDevice = udid,
): Promise<void> {
  udid = udid.toUpperCase();
  preparedDevice = preparedDevice.toUpperCase();
  if (preparedDevice !== udid) {
    await withLaunchStateLock(preparedDevice, async () => {
      if (residentEgress(preparedDevice))
        throw new Error(
          "Resident adoption cannot retire a different prepared device; use a cold start",
        );
    });
  }
  await withLaunchStateLock(udid, () => compatibleEgressAdoption(udid, requested, ownerPid));
}

export async function requiredEgressAdoption(
  udid: string,
  policy: EgressPolicy | undefined,
  signal: AbortSignal,
): Promise<void> {
  udid = udid.toUpperCase();
  try {
    await withLaunchStateLock(udid, async () => {
      signal.throwIfAborted();
      const requested = await compatibleEgressAdoption(udid, policy, process.pid);
      signal.throwIfAborted();
      if (requested === undefined) return;
      await publishResidentEgressPolicyUnlocked(udid, requested.policy, requested.guard);
      signal.throwIfAborted();
    });
  } catch (error) {
    // The private owner keeps its generic response; retain policy and cleanup causes for the operator.
    if (policy !== undefined) console.error("[serve-sim] egress adoption failed", error);
    throw error;
  }
}
