const REDACTED = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "cookie2",
  "set-cookie2",
  "x-firebase-appcheck",
  "x-amz-content-sha256",
]);

const SENSITIVE_HEADER_PATTERN =
  /(^|[-_])(auth|authz|token|secret|password|passwd|credential|session|cookie|key|apikey|api[-_]?key|access[-_]?key|private[-_]?key|signature|bearer)([-_]|$)/i;

const SENSITIVE_HEADER_PREFIX_PATTERN =
  /(^|[-_])(authorization|authentication|sessionid|oidc|jwt|principal|assertion)/i;

// High-signal words that name a credential wherever they appear, so joined names such as
// `X-CSRFToken` or `x-apitoken` are caught too. `key` and `auth` stay bounded above: as substrings
// they would hit `keep-alive` and `:authority`. Redacting a header that was not secret hides only
// its value; the name stays readable.
const SENSITIVE_HEADER_SUBSTRING_PATTERN = /(token|secret|passw|credential|cookie|session)/i;

export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(lower)
    || SENSITIVE_HEADER_PATTERN.test(lower)
    || SENSITIVE_HEADER_PREFIX_PATTERN.test(lower)
    || SENSITIVE_HEADER_SUBSTRING_PATTERN.test(lower)
  );
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isSensitiveHeaderName(name) ? REDACTED : value]),
  );
}
