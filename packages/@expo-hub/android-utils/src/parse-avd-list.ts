const AVAILABLE_HEADER = "Available Android Virtual Devices:";
const UNAVAILABLE_MARKER = "could not be loaded:";
const BLOCK_SEPARATOR = /^\s*-{3,}\s*$/m;

/**
 * Parse the output of `avdmanager list avd` into one property map per AVD.
 *
 * Each map holds the `key: value` fields of a block (e.g. `Name`, `Path`,
 * `Target`). The header line and the trailing "could not be loaded" section
 * are ignored. Never throws.
 */
export function parseAvdList(stdout: string): Record<string, string>[] {
  const section = availableSection(stdout);
  if (!section) return [];

  return section.split(BLOCK_SEPARATOR).map(parseBlock).filter(hasName);
}

function availableSection(stdout: string): string {
  const start = stdout.indexOf(AVAILABLE_HEADER);
  const body = start === -1 ? stdout : stdout.slice(start + AVAILABLE_HEADER.length);

  const end = body.indexOf(UNAVAILABLE_MARKER);
  return end === -1 ? body : body.slice(0, end);
}

function parseBlock(block: string): Record<string, string> {
  const properties: Record<string, string> = {};

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    properties[key] = line.slice(separator + 1).trim();
  }

  return properties;
}

function hasName(properties: Record<string, string>): boolean {
  const name = properties.Name;
  return typeof name === "string" && name.length > 0;
}
