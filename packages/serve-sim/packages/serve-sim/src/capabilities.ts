/** A dylib loaded inside each eligible app process. */
export interface PreparedCapability {
  dylib: string;
  env?: Record<string, string>;
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

export interface CapabilityDefinition {
  name: string;
  defaultEnabled: boolean;
  /** Fixed by the capability, not the caller. */
  scope: CapabilityScope;
  /** Delay before loading on the app main queue; defaults to zero. */
  loadDelayMs?: number;
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

/**
 * Only caller is `setCapabilityEnabled`, which is kept for open PRs #148,
 * #102, and #53. Remove the tag when one of them lands.
 * @public
 */
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

// On-demand enables, like a clipboard read, must not override a device's --disable.
const disabledByDevice = new Map<string, ReadonlySet<string>>();

export function rememberDisabledCapabilities(udid: string, names: readonly string[]): void {
  disabledByDevice.set(udid, new Set(names));
}

export function capabilityIsDisabled(udid: string, name: string): boolean {
  const own = disabledByDevice.get(udid);
  if (own) return own.has(name);
  // A device this process did not launch, such as one picked in the grid, follows the session.
  for (const names of disabledByDevice.values()) if (names.has(name)) return true;
  return false;
}

export function capabilitiesToApply({
  enable = [],
  disable = [],
}: CapabilityOverrides): CapabilityDefinition[] {
  const known = registeredCapabilities();
  const names = known.map((definition) => definition.name);
  for (const name of [...enable, ...disable]) {
    if (!registry.has(name)) throw new UnknownCapabilityError(name, names);
  }
  return known.filter(
    (definition) =>
      !disable.includes(definition.name) &&
      (definition.defaultEnabled || enable.includes(definition.name)),
  );
}
