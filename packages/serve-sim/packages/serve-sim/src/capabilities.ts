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
