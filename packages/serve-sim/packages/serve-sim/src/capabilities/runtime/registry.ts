import type { CapabilityDefinition, CapabilityOverrides } from "./capability";

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

export function registeredCapabilities(): CapabilityDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
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
export function missingCapabilities(
  { enable = [], disable = [] }: CapabilityOverrides,
  applied: readonly string[],
): string[] {
  return enable.filter((name) => !disable.includes(name) && !applied.includes(name));
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
