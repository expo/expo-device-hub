/**
 * Parse a `config.ini` (Java properties style: one `key=value` per line).
 *
 * Blank lines and `#` / `;` comments are ignored. The value is split on the
 * first `=` only, so values may themselves contain `=`. Never throws.
 */
export function parseConfigIni(text: string): Record<string, string> {
  const config: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!isAssignment(line)) continue;

    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (!key) continue;

    config[key] = line.slice(separator + 1).trim();
  }

  return config;
}

function isAssignment(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("#") || line.startsWith(";")) return false;
  return line.includes("=");
}
