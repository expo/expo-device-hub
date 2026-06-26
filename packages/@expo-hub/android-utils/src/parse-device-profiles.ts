import type { AndroidDeviceProfile } from "./types";

const HEADER = "Available devices definitions:";
const BLOCK_SEPARATOR = /^\s*-{3,}\s*$/m;
const ID_LINE = /^id:\s*(\d+)\s*or\s*"(.*)"\s*$/;

/**
 * Parse the output of `avdmanager list device` into one profile per block.
 *
 * Each block starts with an `id: <index> or "<id>"` line followed by `Name`,
 * `OEM` and an optional `Tag` field. Blocks without a parseable id line are
 * skipped. Never throws.
 */
export function parseDeviceProfiles(stdout: string): AndroidDeviceProfile[] {
  const start = stdout.indexOf(HEADER);
  const body = start === -1 ? stdout : stdout.slice(start + HEADER.length);

  return body.split(BLOCK_SEPARATOR).map(parseBlock).filter(isProfile);
}

function parseBlock(block: string): AndroidDeviceProfile | null {
  let id: string | null = null;
  let index: number | null = null;
  const fields: Record<string, string> = {};

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const idMatch = ID_LINE.exec(line);
    if (idMatch) {
      id = idMatch[2] ?? null;
      const parsed = Number(idMatch[1]);
      index = Number.isNaN(parsed) ? null : parsed;
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    fields[key] = line.slice(separator + 1).trim();
  }

  if (!id) return null;

  return {
    id,
    index,
    name: fields.Name ?? "",
    oem: fields.OEM ?? null,
    tag: fields.Tag ?? null,
  };
}

function isProfile(profile: AndroidDeviceProfile | null): profile is AndroidDeviceProfile {
  return profile !== null;
}
