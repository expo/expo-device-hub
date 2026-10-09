// A wildcard needs two labels after the star, which stops a bare TLD like `*.com`.
const WILDCARD_HOST = /^\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** Whether `value` is a `--cors-origin` wildcard such as `https://*.expo.dev`. */
export function isWildcardOrigin(value: string): boolean {
  try {
    return WILDCARD_HOST.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a `--cors-origin` value names `origin`, exactly or through a leading `*.` wildcard.
 * serve-sim's `originMatches`, which serve-emu copies too: canonical origins compare, and a
 * wildcard covers subdomains only, never the bare host, with the same scheme and port.
 */
export function originMatches(configured: string, origin: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.origin === origin.origin) return true;
  if (!WILDCARD_HOST.test(parsed.hostname)) return false;
  const suffix = parsed.hostname.slice(1).toLowerCase();
  const host = origin.hostname.toLowerCase();
  return (
    parsed.protocol === origin.protocol &&
    parsed.port === origin.port &&
    host.length > suffix.length &&
    host.endsWith(suffix)
  );
}
