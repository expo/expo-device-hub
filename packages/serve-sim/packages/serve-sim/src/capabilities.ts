import { readLaunchState } from "./launch-state";

/** A dylib loaded inside each eligible app process. */
export interface PreparedCapability {
  dylib: string;
  env?: Record<string, string>;
  committed?(): void;
  failed?(error: unknown): void;
  rollback?(error: unknown): Promise<void>;
}

/** `allApps` includes system apps such as Safari. */
export type CapabilityScope = "userApps" | "allApps";

export interface CapabilityContext {
  udid: string;
  /** Optional launch target; does not narrow the capability scope. */
  bundleId: string | null;
  /** Capability-specific options, such as a camera source. */
  options: Record<string, string>;
  enabled: boolean;
}

/** Startup plus deferred also attaches to apps that were running when enabled. */
export type CapabilityLoadPhase = "startup" | "deferred" | "startupAndDeferred";

export interface CapabilityDefinition {
  name: string;
  defaultEnabled: boolean;
  exclusive?: boolean;
  /** Fixed by the capability, not the caller. */
  scope: CapabilityScope;
  /** Delay before loading on the app main queue; defaults to zero. */
  loadDelayMs?: number;
  loadPhase?: CapabilityLoadPhase;
  /** Starts/stops host resources. Return null to decline enabling. */
  setEnabled(ctx: CapabilityContext): Promise<PreparedCapability | null>;
}

const registry = new Map<string, CapabilityDefinition>();

export function registerCapability(definition: CapabilityDefinition): void {
  registry.set(definition.name, definition);
}

export function clearRegisteredCapabilities(): void {
  registry.clear();
}

export function capabilityDefinition(name: string): CapabilityDefinition {
  const definition = registry.get(name);
  if (!definition) {
    throw new UnknownCapabilityError(
      name,
      registeredCapabilities().map((known) => known.name),
    );
  }
  return definition;
}

export function assertKnownCapabilities(names: string[]): void {
  const known = registeredCapabilities().map((definition) => definition.name);
  for (const name of names) {
    if (!registry.has(name)) throw new UnknownCapabilityError(name, known);
  }
}

export function hasDefaultCapabilities(): boolean {
  return registeredCapabilities().some((definition) => definition.defaultEnabled);
}

export function registeredCapabilities(): CapabilityDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface CapabilityOverrides {
  enable?: string[];
  disable?: string[];
}

export class UnknownCapabilityError extends Error {
  constructor(name: string, known: string[]) {
    super(
      `Unknown capability '${name}'. ` +
        (known.length > 0 ? `Available: ${known.join(", ")}.` : "None are registered."),
    );
  }
}

/**
 * Requested capabilities that did not apply. A name that `--disable` also names is left out: disable
 * wins, so it is not expected to apply.
 */
export function missingCapabilities({ enable = [], disable = [] }: CapabilityOverrides, applied: readonly string[]): string[] {
  return enable.filter((name) => !disable.includes(name) && !applied.includes(name));
}

// On-demand enables, like a clipboard read, must not override a device's --disable.
const disabledByDevice = new Map<string, ReadonlySet<string>>();

export function rememberDisabledCapabilities(udid: string, names: readonly string[]): void {
  disabledByDevice.set(udid, new Set(names));
}

export function forgetDisabledCapabilities(udid: string): void {
  disabledByDevice.delete(udid);
}

export function capabilityIsDisabled(udid: string, name: string): boolean {
  const shared = readLaunchState(udid);
  if (shared?.disabledCapabilities?.[name]?.length) return true;
  // A session started on another device carries its disable into later grid selections,
  // even if the selected device already has a reader from an earlier session.
  for (const [device, names] of disabledByDevice) {
    if (device !== udid && names.has(name)) return true;
  }
  // On the session's original device, a later shared enable supersedes its prior disable.
  if (shared?.capabilities[name]) return false;
  // A session's disable also applies to devices selected later in the grid, even if that
  // device has its own local entry from a previous launch in this process.
  for (const names of disabledByDevice.values()) if (names.has(name)) return true;
  return false;
}

export function capabilitiesToApply({
  enable = [],
  disable = [],
}: CapabilityOverrides): CapabilityDefinition[] {
  const known = registeredCapabilities();
  assertKnownCapabilities([...enable, ...disable]);
  return known.filter(
    (definition) =>
      !disable.includes(definition.name) &&
      (definition.defaultEnabled || enable.includes(definition.name)),
  );
}
